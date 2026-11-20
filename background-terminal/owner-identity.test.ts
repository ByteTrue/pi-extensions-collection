import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerBackgroundTerminal, { BackgroundManager, reapOrphans } from "./background-terminal.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const isolated = mkdtempSync(join(actual.tmpdir(), "pi-bg-owner-"));
  return { ...actual, tmpdir: () => isolated };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn() };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const DIR = join(tmpdir(), "background-terminal");
const OWNER = 424_242;
const CHILD = 424_243;
const paths: string[] = [];
const journals: string[] = [];
let commandLine = "";

function fixture(ownerStart: unknown, childStart = "child-start"): string {
  const id = "bg_" + randomBytes(8).toString("hex");
  const journalName = id + ".journal.json";
  const journalPath = join(DIR, journalName);
  const pidPath = join(DIR, id + ".pid");
  const startPath = join(DIR, id + ".start");
  const outputPath = join(DIR, id + ".log");
  paths.push(journalPath, pidPath, startPath, outputPath);
  journals.push(journalName);
  writeFileSync(journalPath, JSON.stringify({
    taskId: id, ownerPid: OWNER, ownerStart, command: "npm run dev", pidPath, startPath, outputPath,
    startedAt: Date.now() - 60 * 60 * 1000,
  }));
  writeFileSync(pidPath, String(CHILD));
  writeFileSync(startPath, childStart);
  writeFileSync(outputPath, "Development server ready\n");
  return journalPath;
}

function probeOutput(file: string, args: readonly string[]): string {
  if (/taskkill(?:\.exe)?$/i.test(file)) return "";
  const command = args.join(" ");
  if (/CommandLine|command=/.test(command)) return commandLine;
  if (command.includes(String(OWNER))) return "current-owner-start";
  if (command.includes(String(CHILD))) return "child-start";
  if (command.includes(String(process.pid))) return "actual-owner-start";
  throw new Error("Unexpected process probe: " + command);
}

function mockQueries(result: (file: string, args: readonly string[]) => string | Promise<string>): void {
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    Promise.resolve().then(() => result(file, args)).then(
      (stdout) => callback(null, stdout, ""),
      (error: Error) => callback(error, "", ""),
    );
    return {} as ChildProcess;
  }) as typeof execFile);
}

beforeEach(() => {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // List only our fixtures; all process signals and termination commands stay mocked.
  vi.mocked(readdirSync).mockImplementation(() => journals.slice() as never);
  vi.spyOn(process, "kill").mockReturnValue(true);
  commandLine = "";
  mockQueries(probeOutput);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
  for (const path of paths.splice(0)) rmSync(path, { force: true });
  journals.length = 0;
});

afterAll(() => rmSync(tmpdir(), { recursive: true, force: true }));

function expectNoTermination(): void {
  expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  expect(vi.mocked(execFile).mock.calls.filter(([file]) => /taskkill(?:\.exe)?$/i.test(String(file)))).toEqual([]);
}

describe("orphan owner identity", () => {
  it("shares the in-flight OS owner identity and does not launch a task cancelled while probing", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    mockQueries(async (file, args) => {
      await ready;
      return probeOutput(file, args);
    });
    const manager = new BackgroundManager();
    const session = "owner-journal-test";
    const exec = vi.fn(async (_command, _cwd, { signal }) => new Promise<{ exitCode: number }>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const tasks = Array.from({ length: 3 }, () => manager.start("unused", process.cwd(), session, { operations: { exec } }));
    manager.kill(tasks[2]!.id, session);
    try {
      expect(execFile).toHaveBeenCalledOnce();
      expect(exec).not.toHaveBeenCalled();
      release();
      await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
      for (const task of tasks.slice(0, 2)) {
        expect(JSON.parse(readFileSync(join(DIR, task.id + ".journal.json"), "utf8"))).toMatchObject({
          ownerPid: process.pid, ownerStart: "actual-owner-start",
        });
      }
      expect(existsSync(join(DIR, tasks[2]!.id + ".journal.json"))).toBe(false);
      expect(manager.get(tasks[2]!.id, session)?.status).toBe("killed");
    } finally {
      release();
      await manager.clearSession(session);
    }
  });

  it("reaps a verified child after the owner's PID is reused", async () => {
    const journal = fixture("old-owner-start");
    await reapOrphans();
    expect(existsSync(journal)).toBe(false);
    if (process.platform === "win32") {
      expect(execFile).toHaveBeenCalledWith(expect.stringMatching(/taskkill\.exe$/i),
        ["/PID", String(CHILD), "/T", "/F"], expect.any(Object), expect.any(Function));
    } else {
      expect(process.kill).toHaveBeenCalledWith(-CHILD, "SIGKILL");
    }
  });

  it.each([
    ["matching", "current-owner-start"],
    ["legacy/missing", undefined],
    ["empty", ""],
    ["invalid", 123],
  ])("retains a live owner with a %s recorded identity", async (_kind, ownerStart) => {
    const journal = fixture(ownerStart);
    await reapOrphans();
    expect(existsSync(journal)).toBe(true);
    expectNoTermination();
  });

  it.each(["EACCES", "ETIMEDOUT"])("retains an owner whose current start identity fails with %s", async (code) => {
    const journal = fixture("old-owner-start");
    mockQueries(() => { throw Object.assign(new Error("process start unavailable"), { code }); });
    await reapOrphans();
    expect(existsSync(journal)).toBe(true);
    expectNoTermination();
    expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ timeout: 5000, killSignal: "SIGKILL", windowsHide: true }), expect.any(Function));
  });

  it("still refuses a mismatched child start after owner PID reuse even when its command marker matches", async () => {
    const journal = fixture("old-owner-start", "old-child-start");
    commandLine = "pi-bg:" + journals[0]!.slice(0, -".journal.json".length);
    await reapOrphans();
    expect(existsSync(journal)).toBe(true);
    expectNoTermination();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("recovers a legacy journal after its owner PID is gone", async () => {
    const journal = fixture(undefined);
    vi.mocked(process.kill).mockImplementation((pid, signal) => {
      if (pid === OWNER && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    await reapOrphans();
    expect(existsSync(journal)).toBe(false);
  });

  it("shares overlapping reaps and probes each PID/start only once per pass", async () => {
    const fixtures = Array.from({ length: 6 }, () => fixture("old-owner-start"));
    mockQueries(async (file, args) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return probeOutput(file, args);
    });
    const first = reapOrphans();
    expect(reapOrphans()).toBe(first);
    await first;
    for (const journal of fixtures) expect(existsSync(journal)).toBe(false);
    expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal === 0)).toEqual([[OWNER, 0], [CHILD, 0]]);
    expect(vi.mocked(execFile).mock.calls.filter(([file]) => !/taskkill/i.test(file))).toHaveLength(2);
    if (process.platform === "win32") {
      expect(vi.mocked(execFile).mock.calls.filter(([file]) => /taskkill/i.test(file))).toHaveLength(1);
    } else {
      expect(vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal === "SIGKILL")).toEqual([[-CHILD, "SIGKILL"]]);
    }
  });

  it("queries a child command only once when repeated journals need the fallback", async () => {
    const fixtures = Array.from({ length: 3 }, () => fixture("old-owner-start", ""));
    commandLine = journals.map((name) => "pi-bg:" + name.slice(0, -".journal.json".length)).join(" ");
    await reapOrphans();
    for (const journal of fixtures) expect(existsSync(journal)).toBe(false);
    expect(vi.mocked(execFile).mock.calls.filter(([, args]) => /CommandLine|command=/.test(String(args)))).toHaveLength(1);
  });

  it("retains an unverifiable child and retries failed identities in the next pass", async () => {
    const journal = fixture("old-owner-start");
    mockQueries((file, args) => args.join(" ").includes(String(CHILD)) ? "" : probeOutput(file, args));
    await reapOrphans();
    expect(existsSync(journal)).toBe(true);
    expectNoTermination();
    mockQueries(probeOutput);
    await reapOrphans();
    expect(existsSync(journal)).toBe(false);
    expect(vi.mocked(execFile).mock.calls.filter(([, args]) => String(args).includes(String(OWNER)))).toHaveLength(2);
  });

  it("runs session_start recovery asynchronously while a delayed OS query leaves timers responsive", async () => {
    const journal = fixture("current-owner-start");
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    mockQueries(async (file, args) => {
      await ready;
      return probeOutput(file, args);
    });
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
    registerBackgroundTerminal({
      registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), sendMessage: vi.fn(),
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => { handlers[event] = handler; },
    } as unknown as ExtensionAPI);
    expect(execFile).not.toHaveBeenCalled();
    const ctx = { sessionManager: { getSessionId: () => "async-recovery" }, ui: { setStatus: vi.fn() } };
    let finished = false;
    const startup = handlers.session_start!({}, ctx).then(() => { finished = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(execFile).toHaveBeenCalledOnce();
      expect(finished).toBe(false);
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
      release();
      await startup;
      expect(ctx.ui.setStatus).toHaveBeenCalled();
      expect(existsSync(journal)).toBe(true);
      expectNoTermination();
    } finally {
      release();
      await startup;
      await handlers.session_shutdown!({ reason: "quit" }, ctx);
    }
  });

  // Opt-in measurement: real OS start probes and files, synthetic owners/children,
  // mocked liveness and termination. Never scans or signals unrelated processes.
  it.skipIf(process.env.PI_BACKGROUND_RECOVERY_PROBE !== "1")("measures recovery probes for six stale records", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const execute = promisify(actual.execFile);
    const windows = process.platform === "win32";
    const executable = windows
      ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "ps";
    const startArgs = windows
      ? ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process -Id " + process.pid + " -ErrorAction Stop).StartTime.ToUniversalTime().Ticks"]
      : ["-p", String(process.pid), "-o", "lstart="];
    const options = { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", windowsHide: true } as const;
    const start = (await execute(executable, startArgs, options)).stdout.trim();
    expect(start).not.toBe("");
    let probes = 0;
    let terminations = 0;
    mockQueries(async (file, args) => {
      if (/taskkill(?:\.exe)?$/i.test(file)) {
        terminations++;
        return "";
      }
      probes++;
      const mapped = args.map((arg) => windows
        ? arg.replace(/-Id \d+/, "-Id " + process.pid)
        : arg === String(OWNER) || arg === String(CHILD) ? String(process.pid) : arg);
      return (await execute(file, mapped, options)).stdout;
    });
    const samplesMs: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      journals.length = 0;
      const fixtures = Array.from({ length: 6 }, () => fixture("previous-owner-start", start));
      const began = performance.now();
      await reapOrphans();
      samplesMs.push(Number((performance.now() - began).toFixed(1)));
      for (const journal of fixtures) expect(existsSync(journal)).toBe(false);
    }
    expect(probes).toBe(6);
    if (windows) expect(terminations).toBe(3);
    console.log("Controlled recovery probe (not end-to-end): " + JSON.stringify({
      platform: process.platform, node: process.version, records: 6, samplesMs, probes, terminations,
    }));
  }, 60_000);
});
