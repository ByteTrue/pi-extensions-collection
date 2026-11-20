import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runSubagentCommand } from "./command.js";
import { loadSubagentSettings, loadSubagentSettingsForScope, updateSubagentSettings } from "./settings.js";

it.each([
  ["default", "thinking"],
  ["default", "model"],
  ["role", "thinking"],
  ["role", "model"],
])("saves %s %s without setting the other field", async (target, field) => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-inherit-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  vi.stubEnv("PI_PKG_CFG_DIR", join(cwd, "pi-pkg-cfg"));
  try {
    let pickedRole = false;
    const select = vi.fn(async (title: string, options: string[]) => {
      if (title === "Subagent Settings") {
        return select.mock.calls.length === 1
          ? options.find((option) => option.includes(target === "default" ? "Default Subagent Model & Thinking" : "Configure an Agent Role"))
          : options.find((option) => option.includes("Exit"));
      }
      if (title === "Select an Agent Role to Configure") {
        if (pickedRole) return undefined;
        pickedRole = true;
        return "explore";
      }
      if (title.startsWith("Where")) return options.find((option) => option.startsWith("Global"));
      throw new Error("Unexpected menu: " + title);
    });
    const custom = vi.fn(async (create: (
      tui: { requestRender: () => void },
      theme: { fg: (color: string, value: string) => string; bold: (value: string) => string },
      keybindings: undefined,
      done: (value: string | undefined) => void,
    ) => { focused: boolean; render: (width: number) => string[]; handleInput: (data: string) => void }) => {
      let result: string | undefined;
      const picker = create(
        { requestRender: () => {} }, { fg: (_color, value) => value, bold: (value) => value },
        undefined, (value) => { result = value; },
      );
      picker.focused = true;
      expect(picker.render(100).join("\n")).toContain(CURSOR_MARKER);
      picker.focused = false;
      expect(picker.render(100).join("\n")).not.toContain(CURSOR_MARKER);
      picker.focused = true;
      const lines = picker.render(100);
      const targetLabel = lines[0]?.includes("Select Subagent Model") && field === "model" ? "test/model"
        : lines[0]?.includes("Select Subagent Thinking") && field === "thinking" ? "high"
        : "Inherit";
      for (const char of targetLabel) picker.handleInput(char);
      expect(picker.render(100).some((line) => line.includes("→ " + targetLabel))).toBe(true);
      picker.handleInput("\r");
      return result;
    });
    await runSubagentCommand({
      cwd, hasUI: true, mode: "tui", isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", name: "Test" }] },
      sessionManager: { getSessionId: () => "inherit-test" },
      ui: { select, custom, notify: vi.fn() },
    } as unknown as ExtensionCommandContext);
    const settings = loadSubagentSettingsForScope(cwd, "global");
    const model = target === "default" ? settings.defaultModel : settings.agents?.explore?.model;
    const thinking = target === "default" ? settings.defaultThinking : settings.agents?.explore?.thinking;
    expect(model).toBe(field === "model" ? "test/model" : undefined);
    expect(thinking).toBe(field === "thinking" ? "high" : undefined);
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("project role controls inherit, clear, keep clears, and restore global inheritance per field", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-role-inherit-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "global"));
  vi.stubEnv("PI_PKG_CFG_DIR", join(cwd, "global", "pi-pkg-cfg"));
  const globalRole = { model: "test/global", thinking: "high", tools: ["read"], maxTurns: 150, timeoutMs: 120000 };
  try {
    updateSubagentSettings(cwd, "global", () => ({ agents: { explore: globalRole } }));
    updateSubagentSettings(cwd, "project", () => ({ agents: { explore: { thinking: "low" } } }));
    const configure = async (action: "partial" | "clear" | "keep" | "inherit") => {
      let entered = false;
      const notify = vi.fn();
      const select = vi.fn(async (title: string, options: string[]) => {
        if (title === "Subagent Settings") {
          if (entered) return undefined;
          entered = true;
          return options.find((option) => option.includes("Configure an Agent Role"));
        }
        if (title === "Select an Agent Role to Configure") return "explore";
        if (title.startsWith("Where")) return options.find((option) => option.startsWith("Project"));
        const label = action === "clear" ? "Use role document/default"
          : action === "keep" || action === "partial" && title.startsWith("Select Subagent Thinking") ? "Keep current"
          : "Inherit";
        const selected = options.find((option) => option.startsWith(label));
        expect(selected, title).toBeDefined();
        return selected;
      });
      await runSubagentCommand({
        cwd, hasUI: true, mode: "rpc", isProjectTrusted: () => true,
        modelRegistry: { getAvailable: () => [] },
        ui: { select, notify },
      } as unknown as ExtensionCommandContext);
      expect(notify).toHaveBeenCalledWith(expect.stringContaining('Role "explore" configured'), "info");
      expect(notify.mock.calls.some(([, level]) => level === "error")).toBe(false);
    };

    await configure("partial");
    expect(loadSubagentSettingsForScope(cwd, "project").agents?.explore).toStrictEqual({ thinking: "low" });
    expect(loadSubagentSettings(cwd).agents?.explore).toEqual({ ...globalRole, thinking: "low" });

    const cleared = { model: null, thinking: null, maxTurns: null, timeoutMs: null };
    await configure("clear");
    expect(loadSubagentSettingsForScope(cwd, "project").agents?.explore).toEqual(cleared);
    expect(loadSubagentSettings(cwd).agents?.explore).toEqual({ ...cleared, tools: ["read"] });

    await configure("keep");
    expect(loadSubagentSettingsForScope(cwd, "project").agents?.explore).toEqual(cleared);

    await configure("inherit");
    expect(loadSubagentSettingsForScope(cwd, "project").agents?.explore).toBeUndefined();
    expect(loadSubagentSettings(cwd).agents?.explore).toEqual(globalRole);
  } finally {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
});
