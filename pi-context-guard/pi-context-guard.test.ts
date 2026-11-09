import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import contextGuardDefault, {
	COMPACT_AT_TOKENS,
	buildNudgeReminder,
	decideNudge,
	detectForeignRewriter,
	estimateTokens,
	extractProbes,
	measureTail,
	newNudgeState,
	pruneMessages,
	protectionFloor,
	registerContextGuard,
	searchEntries,
	sessionFileSection,
	shouldCompact,
	stableArgs,
} from "./pi-context-guard.js";

type Usage = { tokens: number | null; contextWindow: number };
type CompactCall = { onComplete?: () => void; onError?: (error: Error) => void };
type ToolDef = {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
};

function harness(opts: { usage?: Usage; sessionFile?: string; entries?: unknown[]; model?: { contextWindow: number; maxTokens?: number } } = {}) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const tools: Record<string, ToolDef> = {};
	const compactCalls: CompactCall[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers[event] = handler;
		},
		registerTool: (def: ToolDef) => {
			tools[def.name] = def;
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	registerContextGuard(pi);
	const ctx = {
		model: opts.model,
		getContextUsage: () => opts.usage,
		compact: (call: CompactCall) => {
			compactCalls.push(call);
		},
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => opts.sessionFile,
			getEntries: () => opts.entries,
		},
	};
	return { handlers, tools, compactCalls, ctx };
}

function beforeAgentStartEvent() {
	return {
		type: "before_agent_start" as const,
		prompt: "hi",
		images: undefined,
		systemPrompt: "system",
		systemPromptOptions: {
			cwd: "/tmp",
			selectedTools: [],
			hiddenTools: [],
			toolSnippets: {},
			toolGuidelines: {},
			promptGuidelines: [],
			appendSystemPrompt: "",
			sections: {} as Record<string, string>,
			contextFiles: [],
			skills: [],
		},
	};
}

describe("shouldCompact", () => {
	it("compacts past the threshold only for large-window models", () => {
		expect(shouldCompact({ tokens: COMPACT_AT_TOKENS + 1, contextWindow: COMPACT_AT_TOKENS + 1 })).toBe(true);
	});

	it("leaves small-window models on Pi's own policy", () => {
		expect(shouldCompact({ tokens: COMPACT_AT_TOKENS + 1, contextWindow: COMPACT_AT_TOKENS })).toBe(false);
		expect(shouldCompact({ tokens: COMPACT_AT_TOKENS + 1, contextWindow: 200_000 })).toBe(false);
	});

	it("does not compact at or below the threshold", () => {
		expect(shouldCompact({ tokens: COMPACT_AT_TOKENS, contextWindow: 1_000_000 })).toBe(false);
		expect(shouldCompact({ tokens: 1_000, contextWindow: 1_000_000 })).toBe(false);
	});

	it("treats unknown token counts as no signal", () => {
		expect(shouldCompact({ tokens: null, contextWindow: 1_000_000 })).toBe(false);
	});
});

describe("agent_settled", () => {
	it("compacts once usage passes the threshold on a large-window model and awaits completion", async () => {
		let settled = false;
		const { handlers, compactCalls, ctx } = harness({ usage: { tokens: COMPACT_AT_TOKENS + 5_000, contextWindow: 1_000_000 } });
		const orig = ctx.compact;
		ctx.compact = (opts: { onComplete?: () => void; onError?: (e: Error) => void }) => {
			orig(opts);
			setTimeout(() => {
				settled = true;
				opts.onComplete?.();
			}, 5);
		};
		await handlers["agent_settled"]?.({}, ctx);
		expect(compactCalls).toHaveLength(1);
		expect(settled).toBe(true);
		expect(typeof compactCalls[0]?.onError).toBe("function");
	});

	it("does not compact below the threshold, on small windows, or without usage", () => {
		const below = harness({ usage: { tokens: 1_000, contextWindow: 1_000_000 } });
		below.handlers["agent_settled"]?.({}, below.ctx);
		expect(below.compactCalls).toHaveLength(0);

		const small = harness({ usage: { tokens: COMPACT_AT_TOKENS + 5_000, contextWindow: 200_000 } });
		small.handlers["agent_settled"]?.({}, small.ctx);
		expect(small.compactCalls).toHaveLength(0);

		const none = harness({});
		none.handlers["agent_settled"]?.({}, none.ctx);
		expect(none.compactCalls).toHaveLength(0);
	});
});

describe("before_agent_start", () => {
	it("points the system prompt at the session file", () => {
		const { handlers, ctx } = harness({ sessionFile: "/s/abc.jsonl" });
		const event = beforeAgentStartEvent();
		handlers["before_agent_start"]?.(event, ctx);
		expect(event.systemPromptOptions.sections.session_file).toBe(sessionFileSection("/s/abc.jsonl"));
		expect(event.systemPromptOptions.sections.session_file).toContain("/s/abc.jsonl");
	});

	it("leaves the prompt alone for ephemeral sessions without a file", () => {
		const { handlers, ctx } = harness({});
		const event = beforeAgentStartEvent();
		handlers["before_agent_start"]?.(event, ctx);
		expect(event.systemPromptOptions.sections.session_file).toBeUndefined();
	});
});

describe("module surface", () => {
	it("default export registers the same hooks", () => {
		const handlers: Record<string, unknown> = {};
		const pi = {
			on: (e: string, h: unknown) => {
				handlers[e] = h;
			},
			registerTool: () => {},
			registerCommand: () => {},
		} as unknown as ExtensionAPI;
		contextGuardDefault(pi);
		expect(Object.keys(handlers).sort()).toEqual(["agent_settled", "before_agent_start", "context", "session_shutdown", "session_start", "tool_result"]);
	});

	it("isolates pruned sets across concurrent sessions on one extension instance", () => {
		const { handlers } = harness();
		const ctxA = { sessionManager: { getSessionId: () => "session-A", getSessionFile: () => undefined } };
		const ctxB = { sessionManager: { getSessionId: () => "session-B", getSessionFile: () => undefined } };
		const msgsA = [bigResult("shared-id", 20_000), ...Array.from({ length: 4 }, (_, i) => bigResult(`n${i}`, 20_000)), ...users(3)];
		const msgsB = [bigResult("shared-id", 20_000), { role: "user", content: "recent" }];
		handlers["context"]?.({ messages: msgsA }, ctxA);
		handlers["context"]?.({ messages: msgsB }, ctxB);
		expect(msgsA[0]?.content).toEqual([{ type: "text", text: "[pruned shared-id]" }]);
		expect(firstTextLength(msgsB[0])).toBe(20_000);
	});

	it("steps aside when another context rewriter is already active on the transcript, but never on file reads", () => {
		expect(detectForeignRewriter([{ role: "assistant", content: "§12§ hello" }])).toBe("magic-context");
		expect(detectForeignRewriter([{ role: "toolResult", content: [{ type: "text", text: "[dropped §4§]" }] }])).toBe("magic-context");
		expect(detectForeignRewriter([{ role: "assistant", content: "## Conversation History (Lossless Context Management)" }])).toBe("pi-lcm");
		expect(detectForeignRewriter([{ role: "toolResult", content: [{ type: "text", text: "[pruned: t1]" }] }])).toBe("pi-condense");
		expect(detectForeignRewriter([bigResult("t1")])).toBeNull();
		// Reading source files or docs that mention foreign markers inside a toolResult must not disable pruning.
		expect(
			detectForeignRewriter([
				{
					role: "toolResult",
					toolCallId: "read-self",
					toolName: "read",
					content: [{ type: "text", text: "README mentions <session-history>, [dropped §4§], [pruned: t1], and\n§12§ mid-file." }],
				},
			]),
		).toBeNull();

		const { handlers } = harness();
		const ctx = { sessionManager: { getSessionId: () => "mc-session", getSessionFile: () => undefined } };
		const msgs = [
			{ role: "assistant", content: "§1§ tagged by magic-context" },
			bigResult("t1"),
			...Array.from({ length: 8 }, () => ({ role: "user", content: "n" })),
		];
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(firstTextLength(msgs[1])).toBe(5000);
	});

	it("restores ctx_reduce drops and stale prunes across /reload or --resume via session_start", () => {
		const entries = [
			{ type: "message", id: "e1", message: bigResult("recent-reduced", 2500) },
			{
				type: "message",
				id: "e2",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "reduce-call", name: "ctx_reduce", arguments: { ids: ["recent-reduced"] } }],
				},
			},
			{ type: "message", id: "e3", message: { role: "user", content: "continue" } },
		];
		const { handlers, ctx } = harness({ entries });
		handlers["session_start"]?.({}, ctx);

		// Even on a mid-loop pass (allowNew = false), the restored reduce stays pruned.
		const msgs = [bigResult("recent-reduced", 2500), { role: "assistant", content: "working" }];
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(msgs[0]?.content).toEqual([{ type: "text", text: "[pruned recent-reduced]" }]);
	});
});

// --- pruning ---------------------------------------------------------------

function bigResult(id: string, chars = 5000) {
	return { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(chars) }] };
}

function reportZero(pruned: Set<string>): boolean {
	return pruned.size === 0;
}

/** First text block's length, for "this one was left whole" assertions. */
function firstTextLength(message: { content?: unknown } | undefined): number {
	const content = message?.content;
	if (!Array.isArray(content)) return 0;
	const first = content[0] as { text?: string } | undefined;
	return first?.text?.length ?? 0;
}

function call(id: string, args: unknown = { cmd: "ls" }) {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }] };
}

/** Floor 0 and zero content distance: only the newest three results stay whole,
 * so a test can focus on one rule at a time. */
const ZERO_WINDOW = 0;
function users(n: number) {
	return Array.from({ length: n }, () => ({ role: "user", content: "n" }));
}

describe("pruneMessages", () => {
	it("replaces a result that is far behind with the canonical placeholder", () => {
		const messages = [bigResult("t1"), bigResult("a"), bigResult("b"), bigResult("c")];
		const report = pruneMessages(messages, { pruned: new Set(), usableWindow: ZERO_WINDOW });
		expect(report.pruned).toBe(1);
		expect(messages[0]?.content).toEqual([{ type: "text", text: "[pruned t1]" }]);
	});

	it("keeps the protected window, small results, and errors whole", () => {
		const recent = [bigResult("t1"), ...users(3)];
		expect(pruneMessages(recent, { pruned: new Set(), usableWindow: 1_000_000 }).pruned).toBe(0);

		const small = [bigResult("t1", 100), bigResult("a"), bigResult("b"), bigResult("c")];
		expect(pruneMessages(small, { pruned: new Set(), usableWindow: ZERO_WINDOW }).pruned).toBe(0);

		const failed = [{ ...bigResult("t1"), isError: true }, bigResult("a"), bigResult("b"), bigResult("c")];
		expect(pruneMessages(failed, { pruned: new Set(), usableWindow: ZERO_WINDOW }).pruned).toBe(0);
	});

	it("placeholder bytes are identical on every pass", () => {
		const messages = [bigResult("t1"), bigResult("a"), bigResult("b"), bigResult("c")];
		const pruned = new Set<string>();
		pruneMessages(messages, { pruned, usableWindow: ZERO_WINDOW });
		const once = JSON.stringify(messages);
		const second = pruneMessages(messages, { pruned, usableWindow: ZERO_WINDOW });
		expect(second.pruned).toBe(0);
		expect(second.replayed).toBe(1);
		expect(JSON.stringify(messages)).toBe(once);
	});

	it("admits no new prune mid tool loop, but still replays existing ones", () => {
		const messages = [bigResult("t1"), bigResult("a"), bigResult("b"), bigResult("c")];
		const pruned = new Set<string>();
		const midLoop = pruneMessages(messages, { pruned, allowNew: false, usableWindow: ZERO_WINDOW });
		expect(midLoop.pruned).toBe(0);
		expect(midLoop.candidates).toBe(1);
		expect(firstTextLength(messages[0])).toBe(5000);
	});

	it("deduplicates identical calls keeping the newest, whatever the age", () => {
		const messages = [call("t1"), bigResult("t1"), call("t2"), bigResult("t2"), bigResult("a"), bigResult("b"), bigResult("c")];
		const report = pruneMessages(messages, { pruned: new Set(), usableWindow: 20_000 });
		expect(report.pruned).toBe(1);
		expect(messages[1]?.content).toEqual([{ type: "text", text: "[pruned t1]" }]);
		expect(firstTextLength(messages[3])).toBe(5000);
	});

	it("does not bust the cache on tiny duplicates", () => {
		const tiny = [call("t1"), bigResult("t1", 20), call("t2"), bigResult("t2", 20), bigResult("a"), bigResult("b"), bigResult("c")];
		expect(pruneMessages(tiny, { pruned: new Set(), usableWindow: 20_000 }).pruned).toBe(0);
		expect(firstTextLength(tiny[1])).toBe(20);
	});

	it("treats argument key order and undefined properties as irrelevant when deduplicating", () => {
		expect(stableArgs({ a: 1, b: undefined })).toBe(stableArgs({ a: 1 }));
		const messages = [
			call("t1", { a: 1, b: 2, c: undefined }),
			bigResult("t1"),
			call("t2", { b: 2, a: 1 }),
			bigResult("t2"),
			bigResult("a"), bigResult("b"), bigResult("c"),
		];
		expect(pruneMessages(messages, { pruned: new Set(), usableWindow: 20_000 }).pruned).toBe(1);
	});

	it("ages by three user turns even when little content follows", () => {
		// 100k window: floor 8000 tokens (32k chars), token distance 25k tokens.
		// The 10 later results (40k chars) push the first one out of the floor.
		const newer = Array.from({ length: 10 }, (_, i) => bigResult(`n${i}`, 4000));
		const kept = [bigResult("old"), ...newer];
		pruneMessages(kept, { pruned: new Set(), usableWindow: 100_000 });
		expect(firstTextLength(kept[0])).toBe(5000);

		const messages = [bigResult("old"), ...newer, ...users(3)];
		pruneMessages(messages, { pruned: new Set(), usableWindow: 100_000 });
		expect(messages[0]?.content).toEqual([{ type: "text", text: "[pruned old]" }]);
	});

	it("keeps the newest results whole even past the turn window", () => {
		const messages = [...users(10), bigResult("newest")];
		expect(pruneMessages(messages, { pruned: new Set(), usableWindow: ZERO_WINDOW }).pruned).toBe(0);
	});

	it("batches requested drops and applies them at the next allowed pass", () => {
		const mid = [bigResult("keep"), bigResult("drop", 10), { role: "assistant", content: "working" }];
		const pruned = new Set<string>();
		const requested = new Set(["drop"]);
		const midReport = pruneMessages(mid, { pruned, allowNew: false, requested, usableWindow: ZERO_WINDOW });
		expect(midReport.queued).toBe(1);
		expect(midReport.pruned).toBe(0);
		expect(firstTextLength(mid[1])).toBe(10);
		const turn = [...mid, { role: "user", content: "next" }];
		const turnReport = pruneMessages(turn, { pruned, allowNew: true, requested, usableWindow: ZERO_WINDOW });
		expect(turnReport.pruned).toBe(1);
		expect(turn[1]?.content).toEqual([{ type: "text", text: "[pruned drop]" }]);
		expect(firstTextLength(turn[0])).toBe(5000);
	});

	it("an unrequested recent result is untouched when only others are requested", () => {
		const messages = [bigResult("a"), bigResult("b"), bigResult("c")];
		const pruned = new Set<string>();
		pruneMessages(messages, { pruned, allowNew: false, requested: new Set(["nope"]), usableWindow: ZERO_WINDOW });
		expect(reportZero(pruned)).toBe(true);
		for (const message of messages) expect(firstTextLength(message)).toBe(5000);
	});

	it("dry run reports without changing any bytes", () => {
		const messages = [bigResult("t1"), bigResult("a"), bigResult("b"), bigResult("c")];
		const before = JSON.stringify(messages);
		const report = pruneMessages(messages, { pruned: new Set(), dryRun: true, usableWindow: ZERO_WINDOW });
		expect(report.pruned).toBe(1);
		expect(report.charsSaved).toBe(5000);
		expect(report.tokensSaved).toBe(estimateTokens("x".repeat(5000)));
		expect(JSON.stringify(messages)).toBe(before);
	});
});

// --- nudge decisions -------------------------------------------------------

describe("decideNudge", () => {
	const inBand = { reclaimableTokens: 50_000, tailTokens: 200_000, userTurn: 3 };

	it("stays quiet below the tail and floor thresholds", () => {
		const state = newNudgeState();
		expect(decideNudge(state, { ...inBand, tailTokens: 10_000 }).fire).toBe(false);
		expect(decideNudge(newNudgeState(), { ...inBand, reclaimableTokens: 5_000 }).fire).toBe(false);
	});

	it("fires on the first upward band crossing and gives full copy", () => {
		const state = newNudgeState();
		const verdict = decideNudge(state, inBand);
		expect(verdict.fire).toBe(true);
		expect(verdict.level).toBe("gentle");
		expect(verdict.sticky).toBe(false);
		expect(verdict.reason).toBe("band-crossing");
		state.lastLevel = "gentle";
		state.lastNudgeU = inBand.reclaimableTokens;
		state.lastFireTurn = inBand.userTurn;
	});

	it("holds same-band re-fires until reclaimable mass regrows 8% of tail", () => {
		const state = newNudgeState();
		Object.assign(state, { lastLevel: "gentle" as const, lastNudgeU: 50_000, lastFireTurn: 0 });
		// Same band, growth under max(25k, 8% of 200k = 16k), turn gap not reached.
		expect(decideNudge(state, { ...inBand, reclaimableTokens: 60_000, userTurn: 1 }).fire).toBe(false);
		// Growth past the threshold, but inside the 5-turn sticky floor: still held.
		expect(decideNudge(state, { ...inBand, reclaimableTokens: 75_000, userTurn: 1 }).reason).toBe("sticky-turn-floor");
		// Growth plus the turn gap re-fires with sticky copy.
		const verdict = decideNudge(state, { ...inBand, reclaimableTokens: 75_000, userTurn: 6 });
		expect(verdict.fire).toBe(true);
		expect(verdict.sticky).toBe(true);
	});

	it("observes a band drop silently, then renders full copy on the next rise", () => {
		const state = newNudgeState();
		Object.assign(state, { lastLevel: "urgent" as const, lastNudgeU: 200_000, lastFireTurn: 0 });
		expect(decideNudge(state, { ...inBand }).fire).toBe(false);
		expect(state.lastLevel).toBe("gentle");
		const verdict = decideNudge(state, { ...inBand, reclaimableTokens: 90_000, userTurn: 9 });
		expect(verdict.fire).toBe(true);
		expect(verdict.level).toBe("firm");
		expect(verdict.sticky).toBe(false);
	});

	it("stays silent right after a reduce until U regrows or the band escalates", () => {
		const state = newNudgeState();
		state.reducedSinceRefresh = true;
		expect(decideNudge(state, inBand).reason).toBe("recent-reduce-refresh");
		state.reducedSinceRefresh = false;
		state.grace = { baselineU: null, preLevel: "urgent" };
		expect(decideNudge(state, inBand).reason).toBe("post-reduce-baseline-pending");
		state.grace = { baselineU: 10_000, preLevel: "urgent" };
		// U well under the refire threshold and no escalation: compliance honoured.
		expect(decideNudge(state, { ...inBand, reclaimableTokens: 15_000 }).reason).toBe("post-reduce-compliance-grace");
		// Regrowth past the threshold releases the grace.
		expect(decideNudge(state, { ...inBand, reclaimableTokens: 40_000 }).fire).toBe(true);
	});

	it("never nags on the pass that applied queued drops", () => {
		expect(decideNudge(newNudgeState(), { ...inBand, appliedDropsThisPass: true }).fire).toBe(false);
	});

	it("preserves compliance grace across the mid-loop context pass after ctx_reduce", async () => {
		const { handlers, tools, ctx } = harness();
		const msgs: Array<{ role: string; toolCallId?: string; toolName?: string; isError?: boolean; content: unknown }> = [
			{ role: "user", content: "u".repeat(160_000) },
			bigResult("old-big", 120_000),
			bigResult("keep-big", 120_000),
			{ role: "user", content: "next" },
		];
		handlers["context"]?.({ messages: msgs }, ctx);

		await tools["ctx_reduce"]?.execute("r1", { ids: ["old-big"] }, undefined, undefined, ctx);
		handlers["tool_result"]?.({ toolCallId: "r1", toolName: "ctx_reduce", content: [{ type: "text", text: "Queued" }] }, ctx);

		msgs.push({ role: "toolResult", toolCallId: "r1", toolName: "ctx_reduce", content: [{ type: "text", text: "Queued" }] });
		handlers["context"]?.({ messages: msgs }, ctx);

		const midTool = handlers["tool_result"]?.(
			{ toolCallId: "mid", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(4000) }] },
			ctx,
		);
		expect(midTool).toBeUndefined();

		msgs.push({ role: "user", content: "turn 3" });
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(msgs[1]?.content).toEqual([{ type: "text", text: "[pruned old-big]" }]);

		const postReduceTool = handlers["tool_result"]?.(
			{ toolCallId: "after", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(4000) }] },
			ctx,
		);
		expect(postReduceTool).toBeUndefined();
	});

	it("applies a queued drop at the next allowed pass when the batch is worth a rewrite", async () => {
		const { handlers, tools, ctx } = harness({ usage: { tokens: 1000, contextWindow: 200_000 } });
		const msgs = [bigResult("drop", 20_000), { role: "assistant", content: "working" }];
		handlers["context"]?.({ messages: msgs }, ctx);
		await tools["ctx_reduce"]?.execute("r1", { ids: ["drop"] }, undefined, undefined, ctx);
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(firstTextLength(msgs[0])).toBe(20_000);

		await handlers["agent_settled"]?.({}, ctx);
		handlers["context"]?.({ messages: [...msgs, { role: "assistant", content: "automatic follow-up" }] }, ctx);
		expect(msgs[0]?.content).toEqual([{ type: "text", text: "[pruned drop]" }]);
	});

	it("holds a small batch that is not worth a rewrite, then applies it on the third pass", async () => {
		const { handlers, tools, ctx } = harness();
		const msgs = [bigResult("small-drop", 5000), { role: "assistant", content: "working" }];
		handlers["context"]?.({ messages: msgs }, ctx);
		await tools["ctx_reduce"]?.execute("r1", { ids: ["small-drop"] }, undefined, undefined, ctx);
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(firstTextLength(msgs[0])).toBe(5000);

		msgs.push({ role: "user", content: "next" });
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(firstTextLength(msgs[0])).toBe(5000);

		msgs.push({ role: "user", content: "next" });
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(firstTextLength(msgs[0])).toBe(5000);

		msgs.push({ role: "user", content: "next" });
		handlers["context"]?.({ messages: msgs }, ctx);
		expect(msgs[0]?.content).toEqual([{ type: "text", text: "[pruned small-drop]" }]);
	});

	it("fires a reminder from the baseline measured at the last context pass", () => {
		const { handlers, ctx } = harness();
		const msgs = [{ role: "user", content: "u".repeat(160_000) }, ...Array.from({ length: 20 }, (_, i) => bigResult(`b${i}`, 10_000))];
		handlers["context"]?.({ messages: msgs }, ctx);

		const res = handlers["tool_result"]?.(
			{ toolCallId: "n1", toolName: "bash", isError: false, content: [{ type: "text", text: "x".repeat(400) }] },
			ctx,
		) as { content?: Array<{ text: string }> } | undefined;
		expect(res?.content?.some((c) => c.text.includes("<system-reminder>"))).toBe(true);
	});
});

describe("protectedIds, measureTail, and ctx_reduce", () => {
	it("keeps the newest reduce receipts and todo out of the reclaimable mass and protects them from explicit drops", async () => {
		const messages = [
			bigResult("old"),
			{ role: "toolResult", toolCallId: "r1", toolName: "ctx_reduce", content: [{ type: "text", text: "x".repeat(4000) }] },
			{ role: "toolResult", toolCallId: "t1", toolName: "todowrite", content: [{ type: "text", text: "x".repeat(4000) }] },
			bigResult("extra"),
			{ role: "user", content: "n" },
		];
		const tail = measureTail(messages, new Set(), undefined, ZERO_WINDOW);
		expect(tail.hints.map((h) => h.id)).toEqual(["old"]);
		expect(tail.reclaimableTokens).toBe(estimateTokens("x".repeat(5000)));
		expect(tail.tailTokens).toBeGreaterThan(tail.reclaimableTokens);

		expect(pruneMessages(messages, { pruned: new Set(), requested: new Set(["t1", "r1"]), allowNew: true, usableWindow: 200_000 }).pruned).toBe(0);
		expect(firstTextLength(messages[1])).toBe(4000);
		expect(firstTextLength(messages[2])).toBe(4000);
	});

	it("offers the oldest reclaimable outputs first, one batch of 15", () => {
		const messages = [
			...Array.from({ length: 20 }, (_, i) => bigResult(`id-${i + 1}`, 4000 + i)),
			{ role: "user", content: "n" },
		];
		const tail = measureTail(messages, new Set(), new Set(["id-20"]), ZERO_WINDOW);
		expect(tail.hints.map((h) => h.id)).toEqual(Array.from({ length: 15 }, (_, i) => `id-${i + 1}`));
		expect(tail.reclaimableCount).toBe(17);

		const reminder = buildNudgeReminder(
			{ fire: true, sticky: false, level: "urgent", reason: "band-crossing" },
			tail.hints,
			{ count: tail.reclaimableCount, tokens: tail.reclaimableTokens },
		);
		expect(reminder).toContain("Oldest reclaimable: bash id-1");
		expect(reminder).toContain("one ctx_reduce call");
	});

	it("counts small results in the reclaimable mass and offers them as hints", () => {
		const messages = [bigResult("small", 2029), bigResult("a"), bigResult("b"), bigResult("c")];
		const tail = measureTail(messages, new Set(), undefined, ZERO_WINDOW);
		expect(tail.reclaimable.map((h) => h.id)).toContain("small");
		expect(tail.hints.map((h) => h.id)).toEqual(["small"]);
	});

	it("counts UTF-8 bytes, so CJK is not undercounted", () => {
		expect(estimateTokens("中文")).toBe(2);
		expect(estimateTokens("x".repeat(8))).toBe(2);
		expect(protectionFloor(872_000)).toBe(43_600);
		expect(protectionFloor(200_000)).toBe(16_000);
	});

	it("counts tool arguments but not thinking when measuring the tail", () => {
		const args = { content: "x".repeat(5000) };
		const messages = [{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "t".repeat(3000) },
				{ type: "toolCall", id: "call", name: "write", arguments: args },
			],
		}];
		const tail = measureTail(messages, new Set(), undefined, ZERO_WINDOW);
		expect(tail.tailTokens).toBe(estimateTokens(JSON.stringify(args)));
		expect(tail.reclaimableTokens).toBe(0);
	});

	it("age pruning never touches a protected result", () => {
		const messages = [
			{ role: "toolResult", toolCallId: "r1", toolName: "ctx_reduce", content: [{ type: "text", text: "x".repeat(9000) }] },
			...Array.from({ length: 60 }, () => ({ role: "user", content: "n" })),
		];
		expect(pruneMessages(messages, { pruned: new Set(), usableWindow: 100_000 }).pruned).toBe(0);
	});

	it("ctx_reduce lists only active context results with exact char counts, ignoring pre-compaction entries", async () => {
		const entries = [
			{ type: "message", id: "pre", message: bigResult("pre-compaction", 50_000) },
			{ type: "message", id: "post", message: bigResult("in-context", 6_000) },
		];
		const { handlers, tools, ctx } = harness({ entries, model: { contextWindow: 4000, maxTokens: 0 } });
		handlers["context"]?.(
			{
				messages: [
					bigResult("in-context", 6_000),
					bigResult("a", 1000),
					bigResult("b", 1000),
					bigResult("c", 1000),
					{ role: "user", content: "hi" },
				],
			},
			ctx,
		);

		const listRes = await tools["ctx_reduce"]?.execute("c1", {}, undefined, undefined, ctx);
		const text = listRes?.content[0]?.text ?? "";
		expect(text).toContain("in-context  6000 chars");
		expect(text).not.toContain("pre-compaction");
	});
});

// --- search & expand -------------------------------------------------------

describe("extractProbes", () => {
	it("pulls the literal symbols out of a natural-language question", () => {
		expect(extractProbes("why did the edit to src/config.ts fail with TS2345?")).toContain("src/config.ts");
		expect(extractProbes("why did the edit to src/config.ts fail with TS2345?")).toContain("TS2345");
		expect(extractProbes("what does buildSessionContext return")).toContain("buildSessionContext");
	});

	it("returns nothing for plain prose", () => {
		expect(extractProbes("why did we choose the simpler option here")).toEqual([]);
	});
});

describe("searchEntries and in-memory entriesFor", () => {
	const entries = [
		{ type: "message", id: "a", message: { role: "user", content: "let us use the sqlite store" } },
		{ type: "message", id: "b", message: { role: "toolResult", toolCallId: "t9", content: [{ type: "text", text: "Error in src/config.ts: TS2345 type mismatch" }] } },
		{ type: "message", id: "c", message: { role: "assistant", content: "unrelated chatter about nothing" } },
	];

	it("finds a message by a symbol that the question only implies", () => {
		const hits = searchEntries(entries, "where did src/config.ts break");
		expect(hits[0]?.id).toBe("b");
	});

	it("returns ids usable by ctx_expand and no hits for absent terms", () => {
		expect(searchEntries(entries, "sqlite")[0]?.id).toBe("a");
		expect(searchEntries(entries, "kubernetes")).toEqual([]);
	});

	it("ctx_search and ctx_expand read from sessionManager.getEntries() even without a session file on disk", async () => {
		const { tools, ctx } = harness({ entries });
		const searchRes = await tools["ctx_search"]?.execute("s1", { query: "src/config.ts" }, undefined, undefined, ctx);
		expect(searchRes?.content[0]?.text).toContain("[b] toolResult");

		const expandRes = await tools["ctx_expand"]?.execute("e1", { id: "t9" }, undefined, undefined, ctx);
		expect(expandRes?.content[0]?.text).toContain("Error in src/config.ts: TS2345 type mismatch");
	});
});
