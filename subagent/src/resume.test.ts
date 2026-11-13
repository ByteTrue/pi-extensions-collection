import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { runSubagentCommand } from "./command.js";
import { subagentManager, type SubagentTaskRecord } from "./index.js";

describe("resume instructions", () => {
  it("includes the child cwd in the task menu's generated call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-resume-cwd-"));
    const parentSessionId = `resume-${Date.now()}`;
    const childId = "sub_resume_cwd";
    const record: SubagentTaskRecord = {
      id: "task-resume-cwd",
      sessionId: childId,
      parentSessionId,
      description: "paused custom cwd",
      agent: "explore",
      status: "paused",
      output: "",
      startedAt: Date.now(),
      controller: new AbortController(),
      notifyOnExit: false,
      done: Promise.resolve(),
      progress: {
        runs: [{ sessionId: childId, cwd: dir, agent: "explore" }],
      } as unknown as SubagentTaskRecord["progress"],
    };
    subagentManager.register(record);
    const notifications: string[] = [];
    let mainMenuCalls = 0;
    let taskMenuCalls = 0;
    let detailMenuCalls = 0;
    const ctx = {
      cwd: dir,
      hasUI: true,
      mode: "rpc",
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => parentSessionId },
      ui: {
        select: vi.fn(async (title: string, options: string[]) => {
          if (title === "Subagent Settings") {
            mainMenuCalls += 1;
            return mainMenuCalls === 1 ? "👀 View Subagent Tasks" : "🚪 Exit";
          }
          if (title.startsWith("Subagent Tasks")) {
            taskMenuCalls += 1;
            return taskMenuCalls === 1 ? options.find((option) => option.includes(record.id)) : "🔙 Back";
          }
          if (title.startsWith(`Task ${record.id}`)) {
            detailMenuCalls += 1;
            return detailMenuCalls === 1 ? "💡 How to Resume" : "🔙 Back";
          }
          throw new Error(`Unexpected picker: ${title}`);
        }),
        notify: (message: string) => notifications.push(message),
      },
    } as unknown as ExtensionCommandContext;

    try {
      await runSubagentCommand(ctx);
      const instructions = notifications.find((message) => message.includes("To resume this session"));
      expect(instructions).toContain(`resume: ${JSON.stringify(childId)}`);
      expect(instructions).toContain(`cwd: ${JSON.stringify(dir)}`);
    } finally {
      await subagentManager.clearSession(parentSessionId);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
