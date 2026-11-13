// auto-compact
//
// One rule for Pi: a model whose context window is larger than 400k tokens
// compacts once the context passes 400k, instead of Pi's default
// "window - reserveTokens". Models with a smaller window are not touched; Pi's
// own policy applies there. Compaction itself stays Pi's own: synchronous, on
// the current model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Compact once the context passes this many tokens — but only for models whose
 * window is larger, so small-window models keep Pi's own compaction policy. */
export const COMPACT_AT_TOKENS = 400_000;

/** The decision: compact only when the model can hold more than the threshold
 * AND the current usage has passed it. `tokens` may be null (right after a
 * compaction, before the next response) — that counts as "don't know". */
export function shouldCompact(usage: { tokens: number | null; contextWindow: number }): boolean {
	if (usage.contextWindow <= COMPACT_AT_TOKENS) return false;
	if (usage.tokens === null) return false;
	return usage.tokens > COMPACT_AT_TOKENS;
}

export function registerAutoCompact(pi: ExtensionAPI): void {
	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted) return;
		const usage = ctx.getContextUsage();
		if (!usage || !shouldCompact(usage)) return;
		// ctx.compact() is fire-and-forget inside Pi; awaiting its callbacks keeps
		// non-interactive runs (--print, RPC) alive until the summary is written.
		await new Promise<void>((resolve) => {
			ctx.compact({
				onComplete: () => resolve(),
				onError: (error) => {
					console.error(`compaction failed: ${error.message}`);
					resolve();
				},
			});
		});
	});
}

export default function (pi: ExtensionAPI): void {
	registerAutoCompact(pi);
}
