import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPi, type RunState } from "./index.js";

function state(id: string): RunState {
  return {
    id,
    agent: "tester",
    prompt: "test",
    sessionId: `sub_${id}`,
    status: "pending",
    finalText: "",
    textTail: "",
    thinkingTail: "",
    stderrTail: "",
    tools: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, ctxTokens: 0, turns: 0 },
  };
}

async function runScript(id: string, lines: string[], maxTurns = 100) {
  const dir = mkdtempSync(join(tmpdir(), `subagent-${id}-`));
  const fake = join(dir, "fake-pi.cjs");
  writeFileSync(fake, lines.join("\n"));
  const previous = process.env.PI_CLI_JS;
  process.env.PI_CLI_JS = fake;
  const run = state(id);
  try {
    const result = await runPi(dir, "test", { maxTurns }, run, () => {});
    return { result, run, cwd: dir };
  } finally {
    if (previous === undefined) delete process.env.PI_CLI_JS;
    else process.env.PI_CLI_JS = previous;
    // Windows can briefly keep a directory locked after the child exits.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const message = (text: string, extra = "") =>
  `process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(text)} }${extra}], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 } } }) + "\\n");`;

function mockChild() {
  return Object.assign(new EventEmitter(), {
    pid: 2147483646,
    exitCode: null as number | null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

describe("runPi lifecycle boundaries", () => {
  it.each(["", "\n"])("reports oversized event lines instead of dropping them (ending %j)", async (ending) => {
    const child = mockChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    syncBuiltinESMExports();
    try {
      const run = state("oversized-event");
      const result = runPi(process.cwd(), "test", {}, run, () => {});
      child.stdout.write(Buffer.from(JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "x".repeat(1024 * 1024) }], stopReason: "error",
      } }) + ending));
      child.emit("close", 0);
      expect(await result).toMatchObject({ failed: true });
      expect(run.status).toBe("failed");
      expect(run.errorMessage).toContain("exceeds 1048576 characters");
    } finally {
      child.emit("close", 0);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it("processes every bounded event in a large stdout chunk", async () => {
    const child = mockChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    syncBuiltinESMExports();
    try {
      const run = state("many-events");
      const result = runPi(process.cwd(), "test", {}, run, () => {});
      const line = JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "x".repeat(60000) }],
      } }) + "\n";
      child.stdout.write(Buffer.from(line.repeat(20)));
      child.emit("close", 0);
      expect(await result).toMatchObject({ failed: false });
      expect(run.usage.turns).toBe(20);
    } finally {
      child.emit("close", 0);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it("kills and drains the child after a non-EPIPE input failure", async () => {
    const child = mockChild();
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    syncBuiltinESMExports();
    try {
      const run = state("input-failure");
      let settled = false;
      const result = runPi(process.cwd(), "test", {}, run, () => {}).then((value) => { settled = true; return value; });
      child.stdin.emit("error", Object.assign(new Error("INPUT_FAILED"), { code: "EIO" }));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(process.platform === "win32" ? spawn.mock.calls.length > 1 : kill.mock.calls.length > 0).toBe(true);
      child.emit("close", 1);
      expect(await result).toMatchObject({ failed: true, output: "INPUT_FAILED" });
      expect(run.status).toBe("failed");
    } finally {
      child.emit("close", 1);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    }
  });

  it("falls back to killing the child when Windows taskkill exits unsuccessfully", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    const child = mockChild();
    const killer = new EventEmitter();
    vi.spyOn(childProcess, "spawn")
      .mockImplementationOnce(() => child as unknown as childProcess.ChildProcess)
      .mockImplementation(() => killer as childProcess.ChildProcess);
    syncBuiltinESMExports();
    try {
      const controller = new AbortController();
      const result = runPi(process.cwd(), "test", {}, state("taskkill-failure"), () => {}, controller.signal);
      controller.abort();
      killer.emit("close", 1);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.emit("close", 1);
      expect(await result).toMatchObject({ failed: true });
    } finally {
      child.emit("close", 1);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("escalates a POSIX group kill after the group leader exits", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.useFakeTimers();
    const child = mockChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    syncBuiltinESMExports();
    try {
      const controller = new AbortController();
      const result = runPi(process.cwd(), "test", {}, state("group-kill"), () => {}, controller.signal);
      controller.abort();
      child.exitCode = 0;
      await vi.advanceTimersByTimeAsync(1500);
      expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      child.emit("close", 0);
      expect(await result).toMatchObject({ failed: true });
    } finally {
      child.emit("close", 0);
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      vi.useRealTimers();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("finishes when journal cleanup is denied", async () => {
    const remove = fs.rmSync;
    const leftovers: string[] = [];
    vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (String(path).endsWith(".journal.json")) {
        leftovers.push(String(path));
        throw Object.assign(new Error("JOURNAL_LOCKED"), { code: "EPERM" });
      }
      remove(path, options);
    });
    syncBuiltinESMExports();
    try {
      const { result } = await runScript("cleanup-denied", [message("done")]);
      expect(result).toMatchObject({ output: "done", failed: false });
      expect(leftovers.length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      for (const path of leftovers) remove(path, { force: true });
    }
  });
  it("lets the current turn's tools finish before enforcing maxTurns", async () => {
    const toolCall = ', { type: "toolCall", id: "read-1", name: "read", arguments: { path: "x" } }';
    const { result, run, cwd } = await runScript("limit-tools", [
      'process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
      message("call read", toolCall),
      'setTimeout(() => process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "x" } }) + "\\n"), 150);',
      'setTimeout(() => process.stdout.write(JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", isError: false }) + "\\n"), 250);',
      'setTimeout(() => process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\\n"), 350);',
      'setTimeout(() => process.exit(0), 1000);',
    ], 1);

    expect(result.paused).toBe(true);
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]?.status).toBe("succeeded");
    expect(result.output).toContain(`cwd: ${JSON.stringify(cwd)}`);
  });

  it("accepts natural completion exactly at maxTurns", async () => {
    const { result, run } = await runScript("limit-natural", [
      'process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
      message("done"),
      'setTimeout(() => process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n"), 50);',
      'setTimeout(() => process.exit(0), 60);',
    ], 1);

    expect(result.failed).toBe(false);
    expect(result.paused).toBeFalsy();
    expect(result.output).toBe("done");
    expect(run.status).toBe("succeeded");
  });

  it.each(["error", "aborted"])("rejects a final %s response even when Pi exits zero", async (stopReason) => {
    const { result, run } = await runScript("assistant-" + stopReason, [
      'console.log(JSON.stringify({ type: "agent_start" }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: ' + JSON.stringify(stopReason) + ' } }));',
      'console.log(JSON.stringify({ type: "agent_end" }));',
    ]);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
    expect(result.output).toContain("partial answer");
    expect(result.output).toContain(stopReason);
  });

  it("clears a retried assistant error when a later response succeeds", async () => {
    const { result, run } = await runScript("assistant-retry", [
      'console.log(JSON.stringify({ type: "agent_start" }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "TRANSIENT_ERROR" } }));',
      'console.log(JSON.stringify({ type: "agent_end" }));',
      message("retry succeeded"),
    ]);

    expect(result).toMatchObject({ output: "retry succeeded", failed: false });
    expect(run.errorMessage).toBeUndefined();
  });

  it("uses the final empty response instead of an earlier answer", async () => {
    const { result, run } = await runScript("empty-final", [message("earlier answer"), message("")]);

    expect(result).toMatchObject({ output: "", failed: false });
    expect(run.finalText).toBe("");
    expect(run.textTail).toBe("");
  });

  it("keeps partial output and appends the fatal child error", async () => {
    const { result, run } = await runScript("partial-failure", [
      'process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
      message("partial answer"),
      'setTimeout(() => { process.stderr.write("FATAL_CHILD_REASON"); process.exit(9); }, 50);',
    ]);

    expect(result.failed).toBe(true);
    expect(result.output).toContain("partial answer");
    expect(result.output).toContain("FATAL_CHILD_REASON");
    expect(run.errorMessage).toBe("FATAL_CHILD_REASON");
  });

  it("keeps streamed text when the child fails before message_end", async () => {
    const { result, run } = await runScript("stream-partial-failure", [
      'process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
      'process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STREAMED_PARTIAL_ANSWER" } }) + "\\n");',
      'setTimeout(() => { process.stderr.write("FATAL_AFTER_STREAM"); process.exit(9); }, 50);',
    ]);

    expect(result.failed).toBe(true);
    expect(result.output).toContain("STREAMED_PARTIAL_ANSWER");
    expect(result.output).toContain("FATAL_AFTER_STREAM");
    expect(run.textTail).toBe("STREAMED_PARTIAL_ANSWER");
  });
});
