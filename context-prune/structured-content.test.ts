import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function toolEvent(id: string, text: string, isError: boolean): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: id,
		toolName: "bash",
		input: { command: "test" },
		content: [{ type: "text", text }],
		structuredContent: { answer: 42 },
		details: undefined,
		isError,
	};
}

describe("structuredContent through the real ExtensionRunner", () => {
	it("survives bash timeout steering and a context-prune reminder", { timeout: 15_000 }, async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-structured-content-"));
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const settingsManager = SettingsManager.create(repoRoot, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd: repoRoot,
				agentDir,
				settingsManager,
				additionalExtensionPaths: [
					join(repoRoot, "bash-timeout/bash-timeout.ts"),
					join(repoRoot, "context-prune/context-prune.ts"),
				],
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			({ session } = await createAgentSession({
				cwd: repoRoot,
				agentDir,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(),
				noTools: "all",
			}));
			const runner = session.extensionRunner;

			const timeoutPatch = await runner.emitToolResult(toolEvent("timeout", "Command timed out after 120 seconds", true));

			await runner.emitContext([{ role: "user", content: "start", timestamp: 1 }]);
			const large: AgentMessage[] = Array.from({ length: 20 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `large-${index}`,
				toolName: "bash",
				content: [{ type: "text", text: "x".repeat(20_000) }],
				isError: false,
				timestamp: index + 2,
			}));
			const working: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "working" }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 30,
			};
			await runner.emitContext([...large, working]);
			const reminderPatch = await runner.emitToolResult(toolEvent("reminder", "ok", false));

			expect(timeoutPatch?.structuredContent).toEqual({ answer: 42 });
			expect(timeoutPatch?.content).toHaveLength(2);
			expect(reminderPatch?.structuredContent).toEqual({ answer: 42 });
			expect(reminderPatch?.content).toHaveLength(2);
			expect(reminderPatch?.content?.[1]).toMatchObject({ type: "text" });
		} finally {
			session?.dispose();
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
