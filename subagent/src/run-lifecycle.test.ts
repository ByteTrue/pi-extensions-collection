import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    rmSync(dir, { recursive: true, force: true });
  }
}

const message = (text: string, extra = "") =>
  `process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(text)} }${extra}], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 } } }) + "\\n");`;

describe("runPi lifecycle boundaries", () => {
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
