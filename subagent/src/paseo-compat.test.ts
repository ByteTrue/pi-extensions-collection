import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import register, { acquireSubagentSession, reapSubagentOrphans, subagentManager } from "./index.js";

it.each(["normal", "shutdown", "stop-on-shutdown", "resume"])("publishes a live pointer and replayable completion (%s)", async (mode) => {
  const stopping = mode === "stop-on-shutdown";
  const shutdown = mode === "shutdown" || stopping;
  const resume = mode === "resume" ? "sub_resume_fixture" : undefined;
  const dir = mkdtempSync(join(tmpdir(), "subagent-paseo-"));
  const child = join(dir, "fake-pi.cjs");
  const released = join(dir, "release");
  const childAgentDir = join(dir, "child-agent");
  const sessionDir = join(childAgentDir, "sessions", "--" + resolve(dir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    subagent: { env: { PI_CODING_AGENT_DIR: childAgentDir } },
  }));
  writeFileSync(child, [
    'const fs = require("node:fs");',
    'const id = process.argv[process.argv.indexOf(process.argv.includes("--session") ? "--session" : "--session-id") + 1];',
    'if (process.env.PI_CODING_AGENT_DIR !== ' + JSON.stringify(childAgentDir) + ') process.exit(42);',
    'const file = process.argv.includes("--session") ? id : ' + JSON.stringify(sessionDir + '/') + ' + "test_" + id + ".jsonl";',
    'fs.writeFileSync(file, "{}\\n");',
    'console.log(JSON.stringify({ type: "agent_start" }));',
    'const timer = setInterval(() => { if (!fs.existsSync(' + JSON.stringify(released) + ')) return; clearInterval(timer); console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}})); }, 20);',
  ].join("\n"));
  vi.stubEnv("PI_CLI_JS", child);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
  const tools = new Map<string, unknown>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const sendMessage = vi.fn();
  const session = "paseo-test";
  const ctx = { sessionManager: { getSessionId: () => session } };
  let asyncDir: string | undefined;
  try {
    if (resume) {
      acquireSubagentSession(dir, childAgentDir, resume, session, false).release();
      writeFileSync(join(sessionDir, `test_${resume}.jsonl`), "{}\n");
    }
    register({
      registerTool: (tool) => tools.set(String(tool.name), tool),
      on: (event, handler) => handlers.set(event, handler as never),
      sendMessage,
    });
    await handlers.get("session_start")?.({}, ctx);
    const { execute } = tools.get("subagent") as { execute: (...args: unknown[]) => Promise<{ details: { id: string; sessionId: string; asyncDir: string } }> };
    const { details } = await execute("call-paseo", { agent: "explore", task: "Read", description: "Read the fixture", cwd: dir, resume }, undefined, undefined, ctx);
    asyncDir = details.asyncDir;
    expect(details).toMatchObject({ mode: "single", status: "running", asyncId: details.id, results: [] });
    const file = join(sessionDir, "test_" + details.sessionId + ".jsonl");
    const status = () => JSON.parse(readFileSync(join(asyncDir!, "status.json"), "utf8"));
    let pointer = file;
    await vi.waitFor(() => {
      const snapshot = status();
      expect(snapshot.state).toBe("running");
      pointer = snapshot.steps[0].sessionFile;
      expect(readFileSync(pointer, "utf8")).toBe("{}\n");
    }, { timeout: 3000 });
    if (resume) expect(details.sessionId).toBe(resume);
    expect(pointer === file).toBe(!resume);
    if (shutdown) await handlers.get("agent_start")?.({}, ctx);
    if (!stopping) {
      writeFileSync(released, "");
      await subagentManager.get(details.id)?.done;
    }
    if (shutdown) {
      expect(sendMessage).not.toHaveBeenCalled();
      await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
      expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({ triggerTurn: false });
    }
    expect(status()).toMatchObject({ state: stopping ? "stopped" : "complete", steps: [{ sessionFile: pointer }] });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    const notice = sendMessage.mock.calls[0]?.[0];
    expect(notice).toMatchObject({ customType: "subagent-notify", details: { id: details.id, sessionId: details.sessionId } });
    expect(notice.content.split("\n").slice(0, 3)).toEqual([
      `Background task ${stopping ? "stopped" : "completed"}: **${details.id}**`,
      "Retention-managed async directory: " + asyncDir,
      "Session file: " + pointer,
    ]);
    if (resume) {
      rmSync(file);
      expect(() => readFileSync(pointer)).toThrow(/ENOENT/);
    }
  } finally {
    await subagentManager.clearSession(session);
    if (asyncDir) rmSync(asyncDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps an aged Paseo resume pointer only while its transcript exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-paseo-reap-"));
  try {
    const transcript = join(dir, "child.jsonl");
    const run = join(dir, "paseo-2147483647-ABC123");
    mkdirSync(run);
    writeFileSync(transcript, "history");
    const win = process.platform === "win32";
    const link = join(run, win ? "session" : "session.jsonl");
    symlinkSync(win ? dir : transcript, link, win ? "junction" : "file");
    const sessionFile = win ? join(link, "child.jsonl") : link;
    writeFileSync(join(run, "status.json"), JSON.stringify({ steps: [{ sessionFile }] }));
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(run, past, past);
    await reapSubagentOrphans(dir);
    expect(readFileSync(sessionFile, "utf8")).toBe("history");
    rmSync(transcript);
    await reapSubagentOrphans(dir);
    expect(existsSync(run)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
