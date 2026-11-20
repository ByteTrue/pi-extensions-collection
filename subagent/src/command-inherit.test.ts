import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { runSubagentCommand } from "./command.js";
import { loadSubagentSettingsForScope } from "./settings.js";

it.each([
  ["default", "thinking"],
  ["default", "model"],
  ["role", "thinking"],
  ["role", "model"],
])("saves %s %s without setting the other field", async (target, field) => {
  const cwd = mkdtempSync(join(tmpdir(), "subagent-inherit-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
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
    ) => { render: (width: number) => string[]; handleInput: (data: string) => void }) => {
      let result: string | undefined;
      const picker = create(
        { requestRender: () => {} }, { fg: (_color, value) => value, bold: (value) => value },
        undefined, (value) => { result = value; },
      );
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
      cwd, hasUI: true, mode: "interactive", isProjectTrusted: () => true,
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
