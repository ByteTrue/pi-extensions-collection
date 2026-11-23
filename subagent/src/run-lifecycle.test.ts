import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
  const dir = fs.realpathSync(mkdtempSync(join(tmpdir(), `subagent-${id}-`)));
  const fake = join(dir, "fake-pi.cjs");
  writeFileSync(fake, lines.join("\n"));
  const previous = process.env.PI_CLI_JS;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CLI_JS = fake;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const run = state(id);
  try {
    const result = await runPi(dir, "test", { maxTurns }, run, () => {});
    return { result, run, cwd: dir };
  } finally {
    if (previous === undefined) delete process.env.PI_CLI_JS;
    else process.env.PI_CLI_JS = previous;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    // Windows can briefly keep a directory locked after the child exits.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const message = (text: string, extra = "") =>
  `process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(text)} }${extra}], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 } } }) + "\\n");`;

function persistSession(id: string, messages: Record<string, unknown>[], unreadable = false) {
  const records = messages.map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n";
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const safe = "--" + process.cwd().replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";',
    'const sessionDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", safe);',
    'fs.mkdirSync(sessionDir, { recursive: true });',
    `const sessionFile = path.join(sessionDir, "2026-11-22T00-00-00-000Z_sub_${id}.jsonl");`,
    unreadable ? "fs.mkdirSync(sessionFile);" : `fs.writeFileSync(sessionFile, ${JSON.stringify(records)});`,
  ].join("\n");
}

const assistantMessage = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
});

const stoppedMessage = (text: string) =>
  `process.stdout.write(${JSON.stringify(JSON.stringify({ type: "message_end", message: assistantMessage(text) }))} + "\\n");`;

function deliveredResultPath(output: string): string {
  const match = /^Complete subagent report \((\d+) characters\): (.+)\nRead this file for the complete, untruncated result\.$/.exec(output);
  expect(match).not.toBeNull();
  return match![2]!;
}

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

async function runChunks(id: string, chunks: string[], exitCode = 0) {
  const child = mockChild();
  vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
  vi.spyOn(process, "kill").mockImplementation(() => true);
  syncBuiltinESMExports();
  try {
    const run = state(id);
    const result = runPi(process.cwd(), "test", {}, run, () => {});
    for (const chunk of chunks) child.stdout.write(Buffer.from(chunk));
    child.emit("close", exitCode);
    return { result: await result, run };
  } finally {
    child.emit("close", 0);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
  }
}

describe("runPi lifecycle boundaries", () => {
  it.each([
    ["tool_execution_update", { type: "tool_execution_update", toolCallId: "read-1" }],
    ["tool_execution_end", { type: "tool_execution_end", toolCallId: "read-1", isError: false }],
    ["toolResult message_end", { type: "message_end", message: { role: "toolResult", content: [] } }],
    ["turn_end", { type: "turn_end", toolResults: [] }],
  ])("delivers the final report after an oversized %s", async (name, event) => {
    const line = JSON.stringify({ ...event, padding: "x".repeat(1024 * 1024) });
    const { result, run } = await runScript("oversized-" + name.replaceAll(" ", "-"), [
      `process.stdout.write(${JSON.stringify(line)} + "\\n");`,
      stoppedMessage("complete answer"),
      'process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");',
    ]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
  });

  it("delivers a completed report followed by an oversized turn_end", async () => {
    const line = JSON.stringify({ type: "turn_end", toolResults: [], padding: "x".repeat(1024 * 1024) });
    const { result, run } = await runScript("oversized-final-turn-end", [
      stoppedMessage("complete answer"),
      `process.stdout.write(${JSON.stringify(line)} + "\\n");`,
      'process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");',
    ]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
  });

  it.each([false, true])("settles a matching tool trace after an oversized end event (isError=%s)", async (isError) => {
    const start = JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} }) + "\n";
    const end = JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", isError, padding: "x".repeat(1024 * 1024) }) + "\n";
    const final = JSON.stringify({ type: "message_end", message: assistantMessage("complete answer") }) + "\n";
    const { result, run } = await runChunks(`oversized-tool-end-${isError}`, [start, end, final]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({ id: "read-1", status: isError ? "failed" : "succeeded", finishedAt: expect.any(Number) });
  });

  it("does not reuse completion evidence after an oversized tool result", async () => {
    const final = JSON.stringify({ type: "message_end", message: assistantMessage("stale answer") }) + "\n";
    const agentEnd = JSON.stringify({ type: "agent_end" }) + "\n";
    const toolResult = JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] }, padding: "x".repeat(1024 * 1024) }) + "\n";
    const { result, run } = await runChunks("oversized-tool-result-retry", [final, agentEnd, toolResult], 1);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
    expect(run.finalText).toBe("stale answer");
  });

  it("leaves tool progress unchanged when oversized completion metadata is ambiguous", async () => {
    const start = JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} }) + "\n";
    const end = JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", result: { isError: true }, isError: false, padding: "x".repeat(1024 * 1024) }) + "\n";
    const final = JSON.stringify({ type: "message_end", message: assistantMessage("complete answer") }) + "\n";
    const { result, run } = await runChunks("oversized-tool-end-nested-metadata", [start, end, final]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.tools[0]).toMatchObject({ id: "read-1", status: "running" });
  });

  it("drains a fragmented oversized event before a CRLF-delimited final report", async () => {
    const oversized = JSON.stringify({ type: "turn_end", padding: "x".repeat(1024 * 1024) }) + "\r\n";
    const final = JSON.stringify({ type: "message_end", message: assistantMessage("complete answer") }) + "\r\n";
    const { result, run } = await runChunks("oversized-fragmented-crlf", [
      oversized.slice(0, 700_000),
      oversized.slice(700_000) + final,
    ]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
  });

  it("discards an oversized skipped event that ends at EOF without a newline", async () => {
    const final = JSON.stringify({ type: "message_end", message: assistantMessage("complete answer") }) + "\n";
    const oversized = JSON.stringify({ type: "turn_end", padding: "x".repeat(1024 * 1024) });
    const { result, run } = await runChunks("oversized-eof", [final, oversized]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
  });

  it.each(["", "\n"])("reports unsupported oversized event lines instead of dropping them (ending %j)", async (ending) => {
    const child = mockChild();
    vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    syncBuiltinESMExports();
    try {
      const run = state("oversized-event");
      const result = runPi(process.cwd(), "test", {}, run, () => {});
      child.stdout.write(Buffer.from(JSON.stringify({ type: "custom_event", payload: "x".repeat(1024 * 1024) }) + ending));
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

  it.each([0, 1])("delivers a small final result when agent_end is at the boundary plus %i", async (extra) => {
    const event = { type: "agent_end", messages: [{ role: "toolResult", content: "redacted history" }], padding: "" };
    const line = JSON.stringify({
      ...event,
      padding: "x".repeat(1024 * 1024 - JSON.stringify(event).length + extra),
    });
    expect(line.length).toBe(1024 * 1024 + extra);
    const { result, run } = await runScript(`agent-end-boundary-${extra}`, [
      message("done"),
      `process.stdout.write(${JSON.stringify(line)} + "\\n");`,
    ]);

    expect(result).toMatchObject({ output: "done", failed: false });
    expect(run.status).toBe("succeeded");
  });

  it.each([0, 1])("delivers a final assistant event at the boundary plus %i", async (extra) => {
    const id = `assistant-event-boundary-${extra}`;
    const emptyLine = JSON.stringify({ type: "message_end", message: assistantMessage("") });
    const report = "x".repeat(1024 * 1024 - emptyLine.length + extra);
    const line = JSON.stringify({ type: "message_end", message: assistantMessage(report) });
    expect(line.length).toBe(1024 * 1024 + extra);
    const { result, run } = await runScript(id, [
      ...(extra === 1 ? [persistSession(id, [assistantMessage(report)])] : []),
      `process.stdout.write(${JSON.stringify(line)} + "\\n");`,
    ]);

    expect(result.failed).toBe(false);
    expect(run.status).toBe("succeeded");
    const file = deliveredResultPath(result.output);
    try {
      expect(fs.readFileSync(file, "utf-8") === report).toBe(true);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it.each(["\n", ""])("recovers a final report over 1 MiB without duplicating history (ending %j)", async (ending) => {
    const report = "完整最终报告 🚀\n" + "x".repeat(1024 * 1024);
    const finalEvent = JSON.stringify({ type: "message_end", message: assistantMessage(report) });
    const history = "HISTORY_SHOULD_NOT_BE_DELIVERED" + "h".repeat(1024 * 1024);
    const { result, run } = await runScript("oversized-final-report", [
      persistSession("oversized-final-report", [
        assistantMessage("intermediate", "toolUse"),
        { role: "toolResult", content: [{ type: "text", text: history }] },
        assistantMessage(report),
      ]),
      message("intermediate"),
      `process.stdout.write(${JSON.stringify(finalEvent)} + ${JSON.stringify(ending)});`,
    ]);

    expect(result.failed).toBe(false);
    expect(run.status).toBe("succeeded");
    expect(run.finalText === report).toBe(true);
    const file = deliveredResultPath(result.output);
    try {
      const delivered = fs.readFileSync(file, "utf-8");
      expect(delivered === report).toBe(true);
      expect(delivered).not.toContain("intermediate");
      expect(delivered).not.toContain("HISTORY_SHOULD_NOT_BE_DELIVERED");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("fails explicitly when an oversized final report has no recoverable session log", async () => {
    const { result, run } = await runScript("missing-recovery", [message("x".repeat(1024 * 1024))]);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("could not be recovered: session log not found");
  });

  it("rejects a recovered assistant message that did not stop successfully", async () => {
    const report = "x".repeat(1024 * 1024);
    const { result, run } = await runScript("mismatched-recovery", [
      persistSession("mismatched-recovery", [assistantMessage(report, "toolUse")]),
      message(report),
    ]);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("stopReason toolUse instead of stop");
  });

  it("fails explicitly when the recovery session log is unreadable", async () => {
    const report = "x".repeat(1024 * 1024);
    const { result, run } = await runScript("unreadable-recovery", [
      persistSession("unreadable-recovery", [assistantMessage(report)], true),
      message(report),
    ]);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toContain("could not be recovered from");
  });

  it("keeps a result below the file threshold inline", async () => {
    const report = "x".repeat(39_999);
    const { result, run } = await runScript("small-inline-result", [message(report)]);

    expect(result.failed).toBe(false);
    expect(result.output === report).toBe(true);
    expect(run.status).toBe("succeeded");
  });

  it("writes an exact-threshold Unicode report to a readable absolute result path", async () => {
    const prefix = "完整结果🚀é";
    const report = prefix + "x".repeat(40_000 - prefix.length);
    expect(report.length).toBe(40_000);
    const { result, run } = await runScript("unicode-file-result", [message(report)]);

    expect(result.failed).toBe(false);
    expect(run.status).toBe("succeeded");
    const file = deliveredResultPath(result.output);
    expect(isAbsolute(file)).toBe(true);
    try {
      expect(fs.readFileSync(file, "utf-8") === report).toBe(true);
      expect(result.output).toContain("40,000".replace(",", "") + " characters");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("fails without returning the large report when its result file cannot be written", async () => {
    const child = mockChild();
    const dir = mkdtempSync(join(tmpdir(), "subagent-result-write-failure-"));
    const blockedTmp = join(dir, "not-a-directory");
    writeFileSync(blockedTmp, "file");
    const keys = ["TMPDIR", "TMP", "TEMP"] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    vi.spyOn(childProcess, "spawn").mockImplementation(() => child as unknown as childProcess.ChildProcess);
    syncBuiltinESMExports();
    try {
      for (const key of keys) process.env[key] = blockedTmp;
      const run = state("result-write-failure");
      const result = runPi(process.cwd(), "test", {}, run, () => {});
      const report = "x".repeat(40_000);
      child.stdout.write(Buffer.from(JSON.stringify({ type: "message_end", message: assistantMessage(report) }) + "\n"));
      child.emit("close", 0);
      const settled = await result;
      expect(settled.failed).toBe(true);
      expect(settled.output.length).toBeLessThan(1000);
      expect(settled.output).toContain("Could not write complete subagent result file");
      expect(run.status).toBe("failed");
    } finally {
      child.emit("close", 0);
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      rmSync(dir, { recursive: true, force: true });
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

  it("preserves a fully delivered result when cleanup exits nonzero after an oversized agent_end", async () => {
    const event = { type: "agent_end", messages: [], padding: "" };
    const line = JSON.stringify({ ...event, padding: "x".repeat(1024 * 1024 - JSON.stringify(event).length + 1) });
    const { result, run } = await runScript("cleanup-nonzero", [
      stoppedMessage("complete answer"),
      `process.stdout.write(${JSON.stringify(line)} + "\\n");`,
      'setTimeout(() => process.exit(17), 50);',
    ]);

    expect(result).toMatchObject({ output: "complete answer", failed: false });
    expect(run.status).toBe("succeeded");
    expect(run.errorMessage).toBeUndefined();
  });

  it("does not treat a stopped assistant response without agent_end as a successful nonzero exit", async () => {
    const { result, run } = await runScript("nonzero-without-agent-end", [
      stoppedMessage("partial but stopped"),
      'setTimeout(() => { process.stderr.write("REAL_EXECUTION_FAILURE"); process.exit(9); }, 50);',
    ]);

    expect(result.failed).toBe(true);
    expect(result.output).toContain("partial but stopped");
    expect(result.output).toContain("REAL_EXECUTION_FAILURE");
    expect(run.status).toBe("failed");
  });

  it("keeps authentication failures failed even after agent_end", async () => {
    const { result, run } = await runScript("authentication-failure", [
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "AUTH_FAILED" } }));',
      'console.log(JSON.stringify({ type: "agent_end" }));',
      'setTimeout(() => process.exit(1), 50);',
    ]);

    expect(result.failed).toBe(true);
    expect(result.output).toContain("AUTH_FAILED");
    expect(run.status).toBe("failed");
  });

  it("does not reuse pre-retry completion evidence after a new final response", async () => {
    const { result, run } = await runScript("retry-missing-agent-end", [
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "TRANSIENT" } }));',
      'console.log(JSON.stringify({ type: "agent_end" }));',
      stoppedMessage("retry output"),
      'setTimeout(() => process.exit(1), 50);',
    ]);

    expect(result.failed).toBe(true);
    expect(run.status).toBe("failed");
  });

  it("accepts a retried final stop with its own agent_end before nonzero cleanup", async () => {
    const { result, run } = await runScript("retry-with-agent-end", [
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "TRANSIENT" } }));',
      'console.log(JSON.stringify({ type: "agent_end" }));',
      stoppedMessage("retry complete"),
      'console.log(JSON.stringify({ type: "agent_end" }));',
      'setTimeout(() => process.exit(1), 50);',
    ]);

    expect(result).toMatchObject({ output: "retry complete", failed: false });
    expect(run.status).toBe("succeeded");
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
