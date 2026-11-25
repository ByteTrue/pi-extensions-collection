import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import register, { acquireSubagentSession, subagentManager, SUBAGENT_ORPHAN_DIR, type JsonObject } from "./index.js";

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-owner-")));
  const agentDir = join(dir, "agent");
  const id = "sub_owned";
  const sessionDir = join(agentDir, "sessions", "--" + resolve(dir).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "test_" + id + ".jsonl");
  const lock = join(agentDir, "subagent-sessions", id + ".lock");
  return { dir, agentDir, id, file, lock };
}

describe("child session ownership", () => {
  it("checks parent and cwd, preserves the exact transcript, and excludes other processes", () => {
    const { dir, agentDir, id, file, lock } = fixture();
    try {
      const initial = acquireSubagentSession(dir, agentDir, id, "parent-a", false);
      writeFileSync(file, "{}\n");
      const contender = 'const fs = require("node:fs"); try { fs.writeFileSync(process.argv[1], "contender", {flag:"wx"}); process.exit(1); } catch (error) { if (error.code !== "EEXIST") throw error; }';
      execFileSync(process.execPath, ["-e", contender, lock]);
      expect(() => acquireSubagentSession(dir, agentDir, id, "parent-a", true)).toThrow(/in use/);
      initial.release();
      expect(() => acquireSubagentSession(dir, agentDir, id, "parent-b", true)).toThrow(/another parent/);
      expect(() => acquireSubagentSession(join(dir, "other"), agentDir, id, "parent-a", true)).toThrow(/original cwd/);
      expect(existsSync(lock)).toBe(false);
      const resumed = acquireSubagentSession(dir, agentDir, id, "parent-a", true);
      expect(resumed.sessionFile).toBe(file);
      resumed.release();
      execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "other-process", {flag:"wx"})', lock]);
      expect(() => acquireSubagentSession(dir, agentDir, id, "parent-a", true)).toThrow(/crash lock/);
      expect(readFileSync(lock, "utf8")).toBe("other-process");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects untracked history and missing transcripts without leaving a lock", () => {
    const { dir, agentDir, id, file, lock } = fixture();
    try {
      writeFileSync(file, "{}\n");
      expect(() => acquireSubagentSession(dir, agentDir, id, "parent", true)).toThrow(/Cannot verify ownership/);
      expect(existsSync(lock)).toBe(false);
      acquireSubagentSession(dir, agentDir, id, "parent", false).release();
      rmSync(file);
      expect(() => acquireSubagentSession(dir, agentDir, id, "parent", true)).toThrow(/no transcript/);
      expect(existsSync(lock)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not remove a lock replaced after acquisition", () => {
    const { dir, agentDir, id, lock } = fixture();
    try {
      const lease = acquireSubagentSession(dir, agentDir, id, "parent", false);
      writeFileSync(lock, "replacement");
      lease.release();
      expect(readFileSync(lock, "utf8")).toBe("replacement");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the tool resumes its own child by the verified path and rejects a different parent", async () => {
    const { dir, agentDir } = fixture();
    const fake = join(dir, "fake.cjs");
    const log = join(dir, "argv.json");
    const journalLog = join(dir, "journal.json");
    writeFileSync(fake, [
      'const fs = require("node:fs"), path = require("node:path");',
      'const args = process.argv.slice(2);',
      'if (args.includes("--session-id")) {',
      ' const id = args[args.indexOf("--session-id") + 1];',
      ' const folder = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "--" + process.cwd().replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--");',
      ' fs.mkdirSync(folder, {recursive:true}); fs.writeFileSync(path.join(folder, "test_" + id + ".jsonl"), "{}\\n");',
      '}',
      'fs.writeFileSync(' + JSON.stringify(log) + ', JSON.stringify(args));',
      'process.stdin.resume(); process.stdin.on("end", () => {',
      ' const journalDir = ' + JSON.stringify(SUBAGENT_ORPHAN_DIR) + ';',
      ' const record = fs.readdirSync(journalDir).filter(name => name.endsWith(".journal.json")).flatMap(name => { try { return [JSON.parse(fs.readFileSync(path.join(journalDir, name), "utf8"))]; } catch { return []; } }).find(record => record.childPid === process.pid);',
      ' fs.writeFileSync(' + JSON.stringify(journalLog) + ', JSON.stringify(record));',
      ' console.log(JSON.stringify({type:"message_end", message:{role:"assistant",content:[{type:"text",text:"done"}]}}));',
      '});',
    ].join("\n"));
    vi.stubEnv("PI_CLI_JS", fake);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_SUBAGENT_CHILD", undefined);
    const tools = new Map<string, JsonObject>();
    const parent = "owner-integration";
    try {
      register({ registerTool: (tool) => tools.set(String(tool.name), tool) });
      const execute = tools.get("subagent")!.execute as (...args: unknown[]) => Promise<{ details: { id: string; sessionId: string } }>;
      const ctx = { cwd: dir, sessionManager: { getSessionId: () => parent } };
      const input = { agent: "explore", description: "Ownership fixture", task: "Read" };
      const initial = await execute("new", input, undefined, undefined, ctx);
      await subagentManager.get(initial.details.id)?.done;
      const resume = { ...input, resume: initial.details.sessionId };
      await expect(execute("foreign", resume, undefined, undefined, { ...ctx, sessionManager: { getSessionId: () => "foreign" } })).rejects.toThrow(/another parent/);
      const resumed = await execute("resume", resume, undefined, undefined, ctx);
      await subagentManager.get(resumed.details.id)?.done;
      expect(subagentManager.get(resumed.details.id)?.status).toBe("succeeded");
      const argv = JSON.parse(readFileSync(log, "utf8")) as string[];
      const sessionFile = argv[argv.indexOf("--session") + 1]!;
      expect(sessionFile).toContain("test_" + initial.details.sessionId + ".jsonl");
      expect(existsSync(sessionFile)).toBe(true);
      expect(JSON.parse(readFileSync(journalLog, "utf8"))).toMatchObject({ sessionId: initial.details.sessionId, sessionFile });
      expect(existsSync(join(agentDir, "subagent-sessions", initial.details.sessionId + ".lock"))).toBe(false);
    } finally {
      await subagentManager.clearSession(parent);
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
