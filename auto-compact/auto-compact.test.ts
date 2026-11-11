import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import autoCompactDefault, { COMPACT_AT_TOKENS, registerAutoCompact, shouldCompact } from "./auto-compact.js";

type Usage = { tokens: number | null; contextWindow: number };
type CompactCall = { onComplete?: () => void; onError?: (error: Error) => void };

function harness(usage?: Usage) {
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
	const compactCalls: CompactCall[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers[event] = handler;
		},
	} as unknown as ExtensionAPI;
	registerAutoCompact(pi);
	const ctx = {
		getContextUsage: () => usage,
		compact: (call: CompactCall) => {
			compactCalls.push(call);
		},
	};
	return { handlers, compactCalls, ctx };
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
		const { handlers, compactCalls, ctx } = harness({ tokens: COMPACT_AT_TOKENS + 5_000, contextWindow: 1_000_000 });
		const orig = ctx.compact;
		ctx.compact = (opts: CompactCall) => {
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
		const below = harness({ tokens: 1_000, contextWindow: 1_000_000 });
		below.handlers["agent_settled"]?.({}, below.ctx);
		expect(below.compactCalls).toHaveLength(0);

		const small = harness({ tokens: COMPACT_AT_TOKENS + 5_000, contextWindow: 200_000 });
		small.handlers["agent_settled"]?.({}, small.ctx);
		expect(small.compactCalls).toHaveLength(0);

		const none = harness();
		none.handlers["agent_settled"]?.({}, none.ctx);
		expect(none.compactCalls).toHaveLength(0);
	});
});

describe("module surface", () => {
	it("default export registers only agent_settled", () => {
		const handlers: Record<string, unknown> = {};
		const pi = {
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
		} as unknown as ExtensionAPI;
		autoCompactDefault(pi);
		expect(Object.keys(handlers)).toEqual(["agent_settled"]);
	});
});
