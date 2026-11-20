import { describe, it, expect, vi } from "vitest";
import { INHERIT, pickModel, pickThinking, runSubagentCommand } from "./command.js";
import { promptFuzzySelect } from "./tui-picker.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSubagentSettings, updateSubagentSettings } from "./settings.js";

describe("command and tui-picker unit tests", () => {
  it("promptFuzzySelect uses select in RPC even when custom exists", async () => {
    const mockCtx = {
      mode: "rpc",
      ui: {
        custom: vi.fn().mockResolvedValue(undefined),
        select: vi.fn().mockResolvedValue("Option A (desc A)"),
      },
    } as unknown as ExtensionCommandContext;

    const items = [
      { value: "opt_a", label: "Option A", description: "desc A" },
      { value: "opt_b", label: "Option B", description: "desc B" },
    ];

    const result = await promptFuzzySelect(mockCtx, "Test title", items);
    expect(result).toBe("opt_a");

    // Test cancel
    (mockCtx.ui.select as any).mockResolvedValue(undefined);
    const cancelResult = await promptFuzzySelect(mockCtx, "Test title", items);
    expect(cancelResult).toBeUndefined();
    expect(mockCtx.ui.custom).not.toHaveBeenCalled();
  });

  it("pickThinking returns selected thinking level or undefined on cancel", async () => {
    const mockCtx = {
      ui: {
        select: vi.fn().mockResolvedValue("high"),
      },
    } as unknown as ExtensionCommandContext;

    const res = await pickThinking(mockCtx);
    expect(res).toBe("high");

    // Inheritance deletes this layer's field; explicit clear bypasses the global role.
    (mockCtx.ui.select as any).mockResolvedValue("Inherit thinking level");
    expect(await pickThinking(mockCtx, "high")).toBe(INHERIT);
    (mockCtx.ui.select as any).mockResolvedValue("Use role document/default");
    expect(await pickThinking(mockCtx, "high", true)).toBeNull();
    (mockCtx.ui.select as any).mockResolvedValue("Keep current (role document/default)");
    expect(await pickThinking(mockCtx, null, true)).toBeNull();

    // Test cancel (ESC)
    (mockCtx.ui.select as any).mockResolvedValue(undefined);
    const cancelRes = await pickThinking(mockCtx);
    expect(cancelRes).toBeUndefined();
  });

  it("keeps global values when project settings override them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-scope-picker-"));
    const agentDir = join(dir, "agent");
    const projectDir = join(dir, "project");
    mkdirSync(projectDir, { recursive: true });
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    updateSubagentSettings(projectDir, "global", (current) => ({
      ...current,
      defaultModel: "global/a",
      defaultThinking: "low",
    }));
    updateSubagentSettings(projectDir, "project", (current) => ({
      ...current,
      defaultModel: "project/b",
      defaultThinking: "high",
    }));
    const notifications: string[] = [];
    let firstMenu = true;
    const ctx = {
      cwd: projectDir,
      hasUI: true,
      mode: "rpc",
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: { getSessionId: () => "scope-test" },
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Subagent Settings") {
            if (firstMenu) {
              firstMenu = false;
              return "⚙️ Configure Default Subagent Model & Thinking";
            }
            return "🚪 Exit";
          }
          if (title === "Where should subagent settings be saved?") {
            return options.find((option) => option.startsWith("Global"));
          }
          if (title.startsWith("Select Subagent Model") || title.startsWith("Select Subagent Thinking Level")) {
            return options.find((option) => option.startsWith("Keep current"));
          }
          throw new Error(`Unexpected picker: ${title}`);
        }),
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    try {
      await runSubagentCommand(ctx);
      const global = loadSubagentSettings(projectDir, false);
      expect(global.defaultModel).toBe("global/a");
      expect(global.defaultThinking).toBe("low");
      expect(notifications.some((message) => message.includes("global/a"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides untrusted project roles in status and the role picker", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-trust-picker-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "global"));
    vi.stubEnv("PI_PKG_CFG_DIR", join(cwd, "global", "pi-pkg-cfg"));
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "agents", "untrusted-doc.md"), "Untrusted role");
    updateSubagentSettings(cwd, "project", () => ({ agents: { "untrusted-config": { model: "x/y" } } }));
    const notify = vi.fn();
    const select = vi.fn(async (title: string, options: string[]) => {
      if (title === "Subagent Settings") {
        return select.mock.calls.length === 1 ? options.find((value) => value.includes("Configure an Agent Role")) : undefined;
      }
      expect(title).toBe("Select an Agent Role to Configure");
      expect(options.join("\n")).not.toContain("untrusted-");
      return undefined;
    });
    const ctx = {
      cwd, hasUI: true, mode: "rpc", isProjectTrusted: () => false,
      ui: { select, notify },
    } as unknown as ExtensionCommandContext;
    try {
      await runSubagentCommand(ctx, "status");
      expect(notify.mock.calls[0]?.[0]).not.toContain("untrusted-");
      await runSubagentCommand(ctx);
      expect(select).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a custom role name that cannot be invoked", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagent-role-validation-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "global"));
    vi.stubEnv("PI_PKG_CFG_DIR", join(cwd, "global", "pi-pkg-cfg"));
    const select = vi.fn()
      .mockResolvedValueOnce("🎭 Configure an Agent Role (e.g. explore)")
      .mockResolvedValueOnce("➕ Enter a new role name...")
      .mockResolvedValue(undefined);
    const notify = vi.fn();
    try {
      await runSubagentCommand({
        cwd, hasUI: true, mode: "rpc", isProjectTrusted: () => false,
        ui: { select, notify, input: vi.fn().mockResolvedValue("invalid\nrole") },
      } as unknown as ExtensionCommandContext);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining("Invalid role name"), "error");
      expect(select.mock.calls.some(([title]) => title.startsWith("Where"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("pickModel returns selected model or undefined on cancel", async () => {
    const mockCtx = {
      modelRegistry: {
        getAvailable: vi.fn().mockReturnValue([
          { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
          { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
        ]),
      },
      ui: {
        select: vi.fn().mockResolvedValue("openai/gpt-4o (GPT-4o)"),
      },
    } as unknown as ExtensionCommandContext;

    const res = await pickModel(mockCtx);
    expect(res).toBe("openai/gpt-4o");

    (mockCtx.ui.select as any).mockResolvedValue("Inherit model");
    expect(await pickModel(mockCtx, "openai/gpt-4o")).toBe(INHERIT);
    (mockCtx.ui.select as any).mockResolvedValue("Use role document/default");
    expect(await pickModel(mockCtx, "openai/gpt-4o", undefined, true)).toBeNull();
    (mockCtx.ui.select as any).mockResolvedValue("Keep current (role document/default)");
    expect(await pickModel(mockCtx, null, undefined, true)).toBeNull();

    // Test cancel (ESC)
    (mockCtx.ui.select as any).mockResolvedValue(undefined);
    const cancelRes = await pickModel(mockCtx);
    expect(cancelRes).toBeUndefined();
  });
});
