import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import subagentExtension, {
  buildAgentRosterText,
  buildPiArgs,
  resolveAgentRole,
  resolveRunCfg,
  subagentManager,
  type JsonObject,
} from "./index.js";

async function executeWithFakePi(cwd: string, input: JsonObject, projectTrusted = true) {
  const fake = join(cwd, "fake-pi.cjs");
  const log = join(cwd, "child.json");
  writeFileSync(fake, [
    'const fs = require("node:fs");',
    'let input = "";',
    'process.stdin.on("data", (chunk) => { input += chunk; });',
    'process.stdin.on("end", () => {',
    '  fs.writeFileSync(' + JSON.stringify(log) + ', JSON.stringify({ argv: process.argv, input }));',
    '  process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");',
    '  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2 } } }) + "\\n");',
    '  process.exit(0);',
    '});',
  ].join("\n"));
  const previousCwd = process.cwd();
  const previousCli = process.env.PI_CLI_JS;
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  const sessionId = `security-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const registered = new Map<string, JsonObject>();
  process.env.PI_CLI_JS = fake;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    subagentExtension({ registerTool: (tool: JsonObject) => registered.set(String(tool.name), tool) });
    const execute = registered.get("subagent")!.execute as (
      id: string,
      params: JsonObject,
      signal: undefined,
      onUpdate: undefined,
      ctx: JsonObject,
    ) => Promise<{ details?: { id?: string } }>;
    process.chdir(cwd);
    const result = await execute("security-call", input, undefined, undefined, {
      sessionManager: { getSessionId: () => sessionId },
      isProjectTrusted: () => projectTrusted,
    });
    const id = result.details?.id;
    if (!id) throw new Error("subagent did not return a task id");
    await subagentManager.get(id)?.done;
    return JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; input: string };
  } finally {
    process.chdir(previousCwd);
    if (previousCli === undefined) delete process.env.PI_CLI_JS;
    else process.env.PI_CLI_JS = previousCli;
    if (previousChild !== undefined) process.env.PI_SUBAGENT_CHILD = previousChild;
    await subagentManager.clearSession(sessionId);
  }
}

describe("subagent security boundaries", () => {
  it("does not let an untrusted project replace the built-in explore during execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-explore-trust-"));
    try {
      mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
      writeFileSync(join(dir, ".pi", "agents", "explore.md"), [
        "---",
        "model: vendor/project-explore",
        "tools: read, bash, edit, write",
        "---",
        "PROJECT_EXPLORE_MARKER",
      ].join("\n"));
      expect(resolveAgentRole(dir, "explore", undefined, true).systemPrompt).toContain("PROJECT_EXPLORE_MARKER");

      const child = await executeWithFakePi(dir, { task: "review", agent: "explore", description: "trust check" }, false);

      expect(child.input).not.toContain("PROJECT_EXPLORE_MARKER");
      expect(child.argv).not.toContain("vendor/project-explore");
      expect(child.argv[child.argv.indexOf("--tools") + 1]).toBe("read,bash,grep,find,ls");
      expect(child.argv).not.toContain("write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters prompt-injecting role names while preserving existing name shapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-role-names-"));
    try {
      const settingsDir = join(dir, ".pi", "pi-pkg-cfg", "subagent");
      mkdirSync(settingsDir, { recursive: true });
      const injected = "project\nINJECT_INSTRUCTION";
      const oversized = "a".repeat(129);
      writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({
        agents: {
          [injected]: {},
          [oversized]: {},
          "db.sleuth": {},
          "database explore": {},
          "审查员": {},
        },
      }));

      const roster = buildAgentRosterText(dir);
      expect(roster).not.toContain(injected);
      expect(roster).not.toContain(oversized);
      expect(roster).toContain("- db.sleuth:");
      expect(roster).toContain("- database explore:");
      expect(roster).toContain("- 审查员:");
      expect(() => resolveAgentRole(dir, injected, undefined, true)).toThrow(/Invalid agent role name/);
      expect(resolveAgentRole(dir, "db.sleuth", undefined, true)).toEqual({});
      expect(resolveAgentRole(dir, "database explore", undefined, true)).toEqual({});
      expect(resolveAgentRole(dir, "审查员", undefined, true)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes an explicit empty tool list to the child as --no-tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-empty-tools-"));
    try {
      const child = await executeWithFakePi(dir, {
        task: "review",
        agent: "explore",
        description: "empty tools",
        tools: [],
      });
      expect(child.argv).toContain("--no-tools");
      expect(child.argv).not.toContain("--tools");

      const roleOverride = resolveRunCfg(
        { agent: "explore" },
        { tools: ["read", "bash"] },
        undefined,
        undefined,
        { agents: { explore: { tools: [] } } },
        true,
      );
      expect(roleOverride.tools).toEqual([]);
      expect(buildPiArgs(roleOverride)).toContain("--no-tools");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
