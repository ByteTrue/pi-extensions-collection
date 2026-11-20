import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, getEventListeners } from "node:events";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundBashOperations } from "./execution.js";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getShellConfig: vi.fn(actual.getShellConfig) };
});

const realSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
const realShellConfig = (await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent")).getShellConfig;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let nextPid = 2_000_000_000;
function controlled() {
  const child = Object.assign(new EventEmitter(), {
    pid: nextPid++, stdout: new PassThrough(), stderr: new PassThrough(), signalCode: null as NodeJS.Signals | null,
  });
  const started = deferred();
  vi.mocked(spawn).mockImplementationOnce(() => { started.resolve(); return child as unknown as ChildProcess; });
  const exit = (code: number | null = 0, end = true, signal: NodeJS.Signals | null = null) => {
    child.signalCode = signal;
    child.emit("exit", code, signal);
    if (end) { child.stdout.end(); child.stderr.end(); }
  };
  const killTree = vi.fn(async () => { exit(null, true, "SIGKILL"); return true; });
  return { child, started: started.promise, exit, killTree, ops: createBackgroundBashOperations(killTree) };
}

beforeEach(() => {
  vi.mocked(spawn).mockReset().mockImplementation(realSpawn);
  vi.mocked(getShellConfig).mockReset().mockImplementation(realShellConfig);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("background execution", () => {
  it("keeps both pipes buffered through a slow write after exit, without concurrent callbacks", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = controlled();
    const blocked = deferred();
    const chunks: string[] = [];
    let active = false;
    const onData = vi.fn((chunk: Buffer) => {
      expect(active).toBe(false);
      chunks.push(chunk.toString());
      if (chunks.length === 1) {
        active = true;
        return blocked.promise.then(() => { active = false; });
      }
    });
    const result = h.ops.exec("controlled", process.cwd(), { onData });
    const done = vi.fn();
    void result.then(done);
    await h.started;
    h.child.stdout.write("first");
    await tick();
    h.exit(0, false);
    // Node may resume stdio when the shell exits; a pending sink must still hold both pipes.
    h.child.stdout.resume();
    h.child.stderr.resume();
    h.child.stdout.end("stdout-tail");
    h.child.stderr.end("stderr-tail");
    await vi.advanceTimersByTimeAsync(250);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(h.child.stdout.isPaused()).toBe(true);
    expect(h.child.stderr.isPaused()).toBe(true);
    expect(done).not.toHaveBeenCalled();
    blocked.resolve();
    await expect(result).resolves.toEqual({ exitCode: 0 });
    expect(chunks.join("")).toBe("firststdout-tailstderr-tail");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rearms the inherited-pipe grace on active output and releases after actual idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = controlled();
    const chunks: string[] = [];
    const result = h.ops.exec("controlled", process.cwd(), { onData: (chunk) => { chunks.push(chunk.toString()); } });
    const done = vi.fn();
    void result.then(done);
    await h.started;
    h.exit(7, false);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(80);
      h.child.stderr.write(String(i));
      await tick();
      expect(done).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ exitCode: 7 });
    expect(chunks.join("")).toBe("0123");
    expect(h.child.stdout.destroyed && h.child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout"])("kills promptly on %s while waiting for the sink, then waits for its last write", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = controlled();
    const blocked = deferred();
    const controller = new AbortController();
    const result = h.ops.exec("controlled", process.cwd(), {
      onData: () => blocked.promise, signal: controller.signal, timeout: reason === "timeout" ? 0.05 : 30,
    }).catch((error: Error) => error);
    const done = vi.fn();
    void result.then(done);
    await h.started;
    h.child.stdout.write("waiting");
    await tick();
    if (reason === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(50);
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child.pid);
    await vi.advanceTimersByTimeAsync(250);
    expect(done).not.toHaveBeenCalled();
    blocked.resolve();
    expect(await result).toEqual(new Error(reason === "abort" ? "aborted" : "timeout:0.05"));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(h.child.listenerCount("exit")).toBe(0);
    expect(h.child.listenerCount("error")).toBe(0);
    for (const pipe of [h.child.stdout, h.child.stderr]) {
      expect(pipe.listenerCount("readable")).toBe(0);
      expect(pipe.listenerCount("end")).toBe(0);
      expect(pipe.listenerCount("error")).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["false", "reject", "throw"])("does not report a completed cancellation when kill returns %s", async (kind) => {
    const h = controlled();
    h.killTree.mockImplementation(() => {
      if (kind === "throw") throw new Error("kill failed");
      return kind === "false" ? Promise.resolve(false) : Promise.reject(new Error("kill failed"));
    });
    const controller = new AbortController();
    const result = h.ops.exec("controlled", process.cwd(), { onData: () => {}, signal: controller.signal }).catch((error: Error) => error);
    const done = vi.fn();
    void result.then(done);
    await h.started;
    controller.abort();
    await tick();
    expect(done).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    h.exit();
    expect(await result).toEqual(new Error("aborted"));
  });

  it.each(["throw", "reject"])("terminates and rejects a callback %s without an unhandled rejection", async (kind) => {
    const h = controlled();
    const failure = new Error("disk full");
    const result = h.ops.exec("controlled", process.cwd(), {
      onData: () => { if (kind === "throw") throw failure; return Promise.reject(failure); },
    }).catch((error: Error) => error);
    await h.started;
    h.child.stderr.write("not saved");
    expect(await result).toBe(failure);
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child.pid);
    expect(h.child.stdout.destroyed && h.child.stderr.destroyed).toBe(true);
  });

  it("handles asynchronous spawn failure and removes timers and abort listeners", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = controlled();
    const controller = new AbortController();
    const failure = new Error("spawn ENOENT");
    const result = h.ops.exec("controlled", process.cwd(), { onData: () => {}, signal: controller.signal, timeout: 10 }).catch((error: Error) => error);
    await h.started;
    h.child.emit("error", failure);
    expect(await result).toBe(failure);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.killTree).not.toHaveBeenCalled();
  });

  it("handles synchronous spawn failure", async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("bad spawn"); });
    await expect(createBackgroundBashOperations(vi.fn()).exec("x", process.cwd(), { onData: () => {} })).rejects.toThrow("bad spawn");
  });

  it("does not spawn with a pre-aborted signal or an abort during cwd access", async () => {
    const controller = new AbortController();
    const ops = createBackgroundBashOperations(vi.fn());
    const first = ops.exec("x", process.cwd(), { onData: () => {}, signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toThrow("aborted");
    await expect(ops.exec("x", process.cwd(), { onData: () => {}, signal: controller.signal })).rejects.toThrow("aborted");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("catches an abort raced with spawning", async () => {
    const h = controlled();
    const controller = new AbortController();
    vi.mocked(spawn).mockReset().mockImplementationOnce(() => { controller.abort(); return h.child as unknown as ChildProcess; });
    await expect(h.ops.exec("x", process.cwd(), { onData: () => {}, signal: controller.signal })).rejects.toThrow("aborted");
    expect(h.killTree).toHaveBeenCalledExactlyOnceWith(h.child.pid);
  });

  it.each([0, -1, Infinity, NaN, 2_147_484])("rejects invalid timeout %s before spawn", async (timeout) => {
    await expect(createBackgroundBashOperations(vi.fn()).exec("x", process.cwd(), { onData: () => {}, timeout })).rejects.toThrow("Invalid timeout");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves cwd errors and rejects unsupported WSL stdin transport", async () => {
    const ops = createBackgroundBashOperations(vi.fn());
    await expect(ops.exec("x", join(process.cwd(), "missing-execution-test-dir"), { onData: () => {} })).rejects.toThrow("Working directory does not exist:");
    vi.mocked(getShellConfig).mockReturnValueOnce({ shell: "wsl-bash", args: ["-s"], commandTransport: "stdin" });
    await expect(ops.exec("x", process.cwd(), { onData: () => {} })).rejects.toThrow("WSL-backed shells");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves explicit env and shell options, adds default agent bin only once, and reports signal exits", async () => {
    const bin = join(getAgentDir(), "bin");
    const key = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    const basePath = (process.env[key] ?? "").split(delimiter).filter((entry) => entry !== bin).join(delimiter);
    vi.stubEnv(key, basePath);
    for (const env of [{ MARKER: "unchanged" }, undefined, undefined]) {
      const h = controlled();
      const result = createBackgroundBashOperations(h.killTree, realShellConfig().shell).exec("x", process.cwd(), { env, onData: () => {}, timeout: 2_147_483 });
      await h.started;
      const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
      if (env) expect(options?.env).toBe(env);
      else expect(options?.env?.[key]?.split(delimiter).filter((entry) => entry === bin)).toHaveLength(1);
      expect(options).toMatchObject({ detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      expect(getShellConfig).toHaveBeenLastCalledWith(realShellConfig().shell);
      h.exit(null, true, "SIGTERM");
      await expect(result).resolves.toEqual({ exitCode: 143 });
      if (!env) vi.stubEnv(key, bin + delimiter + basePath);
    }
  });

  it("does not remove a replacement PID registration when an old exit or write completes", async () => {
    const h = controlled();
    const blocked = deferred();
    const result = h.ops.exec("controlled", process.cwd(), { onData: () => blocked.promise });
    await h.started;
    h.child.stdout.write("pending");
    await tick();
    const children = (globalThis as unknown as Record<symbol, Map<number, unknown>>)[Symbol.for("@bytetrue/pi-background-terminal.executions.v1")]!;
    const replacement = vi.fn();
    children.set(h.child.pid, replacement);
    try {
      h.exit();
      expect(children.get(h.child.pid)).toBe(replacement);
      blocked.resolve();
      await result;
      expect(children.get(h.child.pid)).toBe(replacement);
    } finally {
      blocked.resolve();
      await result;
      children.delete(h.child.pid);
    }
  });

  it("shares one exit hook across executions and reloads and immediately starts cleanup only for active children", async () => {
    const baseline = process.listeners("exit");
    const a = controlled();
    const first = a.ops.exec("a", process.cwd(), { onData: () => {} });
    await a.started;
    const afterFirst = process.listeners("exit");
    vi.resetModules();
    const reloaded = await import("./execution.js");
    const b = controlled();
    const second = reloaded.createBackgroundBashOperations(b.killTree).exec("b", process.cwd(), { onData: () => {} });
    await b.started;
    expect(process.listenerCount("exit")).toBe(afterFirst.length);
    expect(afterFirst.length - baseline.length).toBeLessThanOrEqual(1);
    a.exit();
    await first;
    const children = (globalThis as unknown as Record<symbol, Map<number, unknown>>)[Symbol.for("@bytetrue/pi-background-terminal.executions.v1")];
    expect(children?.has(a.child.pid)).toBe(false);
    expect(children?.has(b.child.pid)).toBe(true);
    // Invoke only this backend's hook, never other process exit handlers.
    const hook = afterFirst.find((listener) => String(listener).includes("killTree"));
    expect(hook).toBeDefined();
    hook!(0);
    expect(b.killTree).toHaveBeenCalledExactlyOnceWith(b.child.pid);
    expect(a.killTree).not.toHaveBeenCalled();
    await second;
    expect(children?.size).toBe(0);
  });
});

// These PIDs come only from shells spawned by this file's real tests.
async function killRealTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
        { timeout: 5000, windowsHide: true }, (error) => resolve(!error));
    });
  }
  try { process.kill(-pid, "SIGKILL"); return true; } catch { return false; }
}

describe("real local shell", () => {
  it("streams stdout/stderr and preserves a nonzero exit", async () => {
    const chunks: Buffer[] = [];
    const result = await createBackgroundBashOperations(killRealTree).exec("printf stdout; printf stderr >&2; exit 7", process.cwd(), {
      timeout: 5, onData: (chunk) => { chunks.push(chunk); },
    });
    expect(result).toEqual({ exitCode: 7 });
    expect(Buffer.concat(chunks).toString()).toContain("stdout");
    expect(Buffer.concat(chunks).toString()).toContain("stderr");
  });

  it("receives every byte from both pipes with a slow sink and bounded writes", { timeout: 15_000 }, async () => {
    let writing = 0;
    let maxWriting = 0;
    let totalA = 0;
    let totalB = 0;
    const result = await createBackgroundBashOperations(killRealTree).exec(
      "node -e 'const fs=require(\"node:fs\");const a=Buffer.alloc(16384,97),b=Buffer.alloc(16384,98);for(let i=0;i<64;i++){fs.writeSync(1,a);fs.writeSync(2,b)}'",
      process.cwd(), { timeout: 10, onData: async (chunk) => {
        maxWriting = Math.max(maxWriting, ++writing);
        await delay(3);
        for (const byte of chunk) { if (byte === 97) totalA++; else if (byte === 98) totalB++; else throw new Error("unexpected output"); }
        writing--;
      } },
    );
    expect(result).toEqual({ exitCode: 0 });
    expect(maxWriting).toBe(1);
    expect(writing).toBe(0);
    expect(totalA).toBe(1_048_576);
    expect(totalB).toBe(1_048_576);
  });
});
