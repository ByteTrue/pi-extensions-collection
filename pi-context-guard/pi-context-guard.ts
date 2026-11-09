// pi-context-guard
//
// Three context rules for Pi:
//
// 1. A model whose context window is larger than 400k tokens compacts once the
//    context passes 400k, instead of Pi's default "window - reserveTokens".
//    Models with a smaller window are not touched; Pi's default applies there.
//
// 2. The system prompt names the session file, which keeps every message even
//    after compaction replaces them in the model's view. So a detail a summary
//    dropped stays reachable, instead of having to be re-derived or guessed.
//
// 3. Deterministic pruning: tool results that are far behind are replaced by a
//    fixed placeholder; ctx_expand returns the original, ctx_search finds it again.
//    Nothing is summarised, generated, embedded, or sent anywhere. Compaction
//    stays Pi's own synchronous, main-model job — pruning only makes it rarer.
//
// Why the system prompt and not the compaction instructions: a summary is only
// as good as whatever produced it. Pi uses another extension's summary verbatim
// when one handles "session_before_compact", and custom instructions are never
// passed to it. The system prompt is unaffected by who compacts, or whether a
// compaction happened at all.
//
// Why pruning is deterministic: a generated summary of a tool result is an
// unaudited claim about what happened. Deleting bytes and keeping the original
// in the session file is not.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

/** Compact once the context passes this many tokens — but only for models whose
 * window is larger, so small-window models keep Pi's own compaction policy. */
export const COMPACT_AT_TOKENS = 400_000;

/** Magic Context's age distance: an output is far behind once this many user
 * turns, or this fraction of the usable window of content, follow it. */
export const AGE_DISTANCE_TURNS = 3;
export const AGE_DISTANCE_WINDOW_FRACTION = 0.25;
/** …and only once it holds at least this many tokens. */
export const AGE_RECLAIM_MIN_TOKENS = 250;
/** Automatic drops and queued agent drops ride a pass only when they reclaim at
 * least this fraction of the usable window, or after this many held passes. */
export const DROP_PRESSURE_FRACTION = 0.02;
export const HELD_PASS_LIMIT = 3;
/** The protected window: a token floor derived from the usable window, the same
 * formula Magic Context uses. */
export const PROTECTED_FLOOR_FRACTION = 0.05;
export const PROTECTED_FLOOR_MIN = 16_000;
export const PROTECTED_FLOOR_MAX = 64_000;
/** Fallback when the host exposes no model window (Magic Context's Pi default). */
export const DEFAULT_USABLE_WINDOW = 200_000;
/** One actionable batch: both the reminder and ctx_reduce list use these. */
export const REDUCE_HINT_LIMIT = 15;
export const REDUCE_HINT_TEXT = "Oldest reclaimable";
/** ctx_expand returns at most this many characters per call, then says where to
 * continue — otherwise expanding one huge output undoes the prune. */
export const EXPAND_CHAR_BUDGET = 60_000;
/** Set to "1" to only report what would be pruned, changing no message bytes. */
export const DRY_RUN_ENV = "PI_CONTEXT_GUARD_DRY_RUN";

/** Tokens per UTF-8 byte. Magic Context measures local token mass this way; for
 * non-ASCII text the byte count matters, so characters would undercount CJK
 * about 3x and keep the nudge bands out of reach. */
export const TOKENS_PER_BYTE = 0.25;
/** Nudge thresholds, in estimated tokens, following Magic Context's bands. */
export const NUDGE_MIN_TAIL_TOKENS = 60_000;
export const NUDGE_FLOOR_TOKENS = 25_000;
export const NUDGE_BANDS = { gentle: 0.2, firm: 0.4, urgent: 0.6 };
/** A recent result of these tools is never counted reclaimable and never
 * pruned: the agent must keep seeing its own plan and its own reduce receipts. */
export const PROTECTED_TOOLS: Readonly<Record<string, number>> = { ctx_reduce: 3, todowrite: 1 };
export const NUDGE_SENTINEL = "<system-reminder>";

export type NudgeLevel = "gentle" | "firm" | "urgent";

export function estimateTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") * TOKENS_PER_BYTE);
}

export interface ReclaimHint {
	id: string;
	toolName: string;
	chars: number;
	tokens: number;
}

export function nudgeBand(reclaimableTokens: number, tailTokens: number): NudgeLevel | "" {
	if (tailTokens < NUDGE_MIN_TAIL_TOKENS || reclaimableTokens < NUDGE_FLOOR_TOKENS) return "";
	const severity = reclaimableTokens / Math.max(tailTokens, 1);
	if (severity >= NUDGE_BANDS.urgent) return "urgent";
	if (severity >= NUDGE_BANDS.firm) return "firm";
	if (severity >= NUDGE_BANDS.gentle) return "gentle";
	return "";
}

/** Growth of reclaimable mass required before a same-band reminder may re-fire.
 * Magic Context: max(25k, 8% of tail). */
export function nudgeRefireTokens(tailTokens: number): number {
	return Math.max(NUDGE_FLOOR_TOKENS, Math.round(0.08 * Math.max(0, tailTokens)));
}

export interface NudgeState {
	lastLevel: NudgeLevel | "";
	lastNudgeU: number;
	lastFireTurn: number;
	reducedSinceRefresh: boolean;
	grace: { baselineU: number | null; preLevel: NudgeLevel | "" } | null;
}

export function newNudgeState(): NudgeState {
	return { lastLevel: "", lastNudgeU: 0, lastFireTurn: -1, reducedSinceRefresh: false, grace: null };
}

export interface NudgeVerdict {
	fire: boolean;
	sticky: boolean;
	level: NudgeLevel | "";
	reason: string;
}

const LEVEL_RANK: Record<string, number> = { "": 0, gentle: 1, firm: 2, urgent: 3 };

/** The whole anti-nagging state machine, as a pure function so it can be
 * tested without a session. Mirrors Magic Context's decideChannel1: grace after
 * a reduce, silence on band de-escalation, growth and turn-gap cadence for
 * same-band re-fires. */
export function decideNudge(state: NudgeState, input: {
	reclaimableTokens: number;
	tailTokens: number;
	userTurn: number;
	appliedDropsThisPass?: boolean;
}): NudgeVerdict {
	const level = nudgeBand(input.reclaimableTokens, input.tailTokens);
	const hold = (reason: string): NudgeVerdict => ({ fire: false, sticky: false, level, reason });
	if (input.appliedDropsThisPass) return hold("drops-applied-this-pass");
	if (state.reducedSinceRefresh) return hold("recent-reduce-refresh");
	if (state.grace && state.grace.baselineU === null) return hold("post-reduce-baseline-pending");
	if (state.grace && state.grace.baselineU !== null) {
		const growth = input.reclaimableTokens - state.grace.baselineU;
		const escalated = (LEVEL_RANK[level] ?? 0) > (LEVEL_RANK[state.grace.preLevel] ?? 0);
		if (growth < nudgeRefireTokens(input.tailTokens) && !escalated) {
			return hold("post-reduce-compliance-grace");
		}
		state.grace = null;
	}
	if (level === "") {
		state.lastLevel = "";
		state.lastNudgeU = 0;
		return hold(input.tailTokens < NUDGE_MIN_TAIL_TOKENS ? "tail-below-minimum" : "reclaimable-below-floor");
	}
	const rank = LEVEL_RANK[level] ?? 0;
	const prevRank = LEVEL_RANK[state.lastLevel] ?? 0;
	if (rank < prevRank) {
		// Falling into a calmer band is an observation, not news worth a reminder.
		state.lastLevel = level;
		state.lastNudgeU = input.reclaimableTokens;
		return hold("band-deescalation");
	}
	const crossed = rank > prevRank;
	const cadence = input.reclaimableTokens - state.lastNudgeU >= nudgeRefireTokens(input.tailTokens);
	const turnGap = state.lastFireTurn < 0 || input.userTurn - state.lastFireTurn >= 5;
	if (!crossed && !cadence) return hold("cadence-growth");
	if (!crossed && !turnGap) return hold("sticky-turn-floor");
	return { fire: true, sticky: !crossed, level, reason: crossed ? "band-crossing" : "cadence-refire" };
}

export function buildNudgeReminder(
	verdict: NudgeVerdict,
	hints: readonly ReclaimHint[],
	totals?: { count: number; tokens: number },
): string {
	const tokens = totals?.tokens ?? hints.reduce((a, h) => a + h.tokens, 0);
	const count = totals?.count ?? hints.length;
	const summary = `${count} tool output(s), ~${tokens} tokens`;
	const hint = hints.length
		? ` ${REDUCE_HINT_TEXT}: ${hints.map((h) => `${h.toolName || "tool"} ${h.id} (${h.chars} chars)`).join(", ")}. Submit the used ids in one ctx_reduce call; no preliminary listing is needed.`
		: "";
	let body: string;
	if (verdict.sticky) body = `Still unstamped: ${summary}. Stamp the ones you've used with ctx_reduce now.`;
	else if (verdict.level === "gentle") body = `Housekeeping: ${summary} are reclaimable. Stamp each output with ctx_reduce as soon as you've taken what you need from it; don't wait for the task to finish.`;
	else if (verdict.level === "firm") body = `${summary} are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue.`;
	else body = `${summary} are still unstamped. Call ctx_reduce once now, before your next tool call, with the listed outputs you've already used.`;
	return `\n\n${NUDGE_SENTINEL}\n${body}${hint}\n</system-reminder>`;
}

/** The placeholder is a pure function of the toolCallId. Anything derived from
 * the (already pruned) content would differ between passes and bust the prompt
 * cache prefix on every turn — the same failure Magic Context documents. */
export function placeholder(toolCallId: string): string {
	return `[pruned ${toolCallId}]`;
}

/** The compaction decision: compact only when the model can hold more than the
 * threshold AND the current usage has passed it. `tokens` may be null (right
 * after a compaction, before the next response) — that counts as "don't know". */
export function shouldCompact(usage: { tokens: number | null; contextWindow: number }): boolean {
	if (usage.contextWindow <= COMPACT_AT_TOKENS) return false;
	if (usage.tokens === null) return false;
	return usage.tokens > COMPACT_AT_TOKENS;
}

/** The system-prompt pointer to the session file. Constant for the whole session,
 * so setting it on every before_agent_start stays inside the cached prefix. */
export function sessionFileSection(sessionFile: string): string {
	return (
		"This session's full history, including parts a compaction summary replaced, is kept " +
		"as JSONL at " + sessionFile + ". Search it when a summary lost a detail you need."
	);
}

// ---------------------------------------------------------------------------
// Pruning
//
// State is per session, in memory only. On resume, earlier ctx_reduce calls
// and stale/duplicate results are re-derived from the session entries, so
// pruned results stay pruned across restarts without any database.
// ---------------------------------------------------------------------------

/** The message shapes pruning looks at, widened to the whole conversation: user
 * text is a plain string, assistant content carries toolCall blocks. */
interface ToolResultLike {
	role: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content?: string | Array<{
		type: string;
		text?: string;
		id?: string;
		name?: string;
		arguments?: unknown;
		thinking?: string;
	}>;
}

export interface PruneReport {
	pruned: number;
	replayed: number;
	charsSaved: number;
	tokensSaved: number;
	candidates: number;
	/** Requested drops held back because this pass is mid tool loop. */
	queued: number;
}

/** Remove the reminder spans this extension appends, so its own copy is not
 * counted as content. Only trailing spans are stripped: a tool result may
 * legitimately contain the sentinel in the middle (reading this file, for
 * example). */
function stripOwnReminder(text: string): string {
	let out = text;
	const close = "</system-reminder>";
	while (out.trimEnd().endsWith(close)) {
		const end = out.trimEnd().length;
		const start = out.lastIndexOf(NUDGE_SENTINEL, end - close.length);
		if (start < 0) break;
		out = out.slice(0, start);
	}
	return out;
}

/** Characters of the provider-visible text, for display only. */
function textLength(msg: ToolResultLike): number {
	if (typeof msg.content === "string") return msg.content.length;
	let n = 0;
	for (const block of msg.content ?? []) {
		if (block.type === "text") n += block.text?.length ?? 0;
		if (block.type === "toolCall") n += JSON.stringify(block.arguments ?? {}).length;
	}
	return n;
}

/** Byte-based token mass of the parts Magic Context counts: text, tool inputs
 * and tool outputs. Reasoning and signatures are excluded. */
function messageTokens(msg: ToolResultLike): number {
	if (typeof msg.content === "string") return estimateTokens(stripOwnReminder(msg.content));
	let n = 0;
	for (const block of msg.content ?? []) {
		if (block.type === "text") n += estimateTokens(stripOwnReminder(block.text ?? ""));
		else if (block.type === "toolCall") n += estimateTokens(JSON.stringify(block.arguments ?? {}));
	}
	return n;
}

function textOf(msg: ToolResultLike): string {
	if (typeof msg.content === "string") return msg.content;
	return (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/** The tool output as the provider sees it, without this extension's reminders. */
function toolOutputText(msg: ToolResultLike): string {
	return stripOwnReminder(textOf(msg));
}

function isPlaceholder(msg: ToolResultLike): boolean {
	const content = Array.isArray(msg.content) ? msg.content : [];
	return content.length === 1 && content[0]?.type === "text" && (content[0].text ?? "").startsWith("[pruned ");
}

/** Ids whose newest results are protected: never pruned, never counted
 * reclaimable. The agent must keep seeing its own plan and its own receipts. */
export function protectedIds(messages: ToolResultLike[]): Set<string> {
	const remaining: Record<string, number> = { ...PROTECTED_TOOLS };
	const out = new Set<string>();
	for (let i = messages.length - 1; i >= 0 && Object.values(remaining).some((n) => n > 0); i--) {
		const msg = messages[i];
		if (msg?.role !== "toolResult" || !msg.toolCallId || !msg.toolName) continue;
		const name = msg.toolName.toLowerCase().replace(/^mcp_/, "");
		if ((remaining[name] ?? 0) <= 0) continue;
		remaining[name] = (remaining[name] ?? 0) - 1;
		out.add(msg.toolCallId);
	}
	return out;
}

/** Token floor protected from automatic pruning, derived like Magic Context's
 * `protected_tokens` default: clamp(5% of the usable window, min(16k, 8%), 64k). */
export function protectionFloor(usableWindow: number): number {
	const usable = Math.max(0, usableWindow);
	const lower = Math.min(PROTECTED_FLOOR_MIN, Math.round(0.08 * usable));
	return Math.min(PROTECTED_FLOOR_MAX, Math.max(lower, Math.round(PROTECTED_FLOOR_FRACTION * usable)));
}

/** The window the model actually has for input: context minus output reserve,
 * with Magic Context's Pi default when the host exposes no model. */
export function usableWindowFor(model?: { contextWindow?: number; maxTokens?: number }): number {
	const window = model?.contextWindow;
	if (!window || !Number.isFinite(window) || window <= 0) return DEFAULT_USABLE_WINDOW;
	return Math.max(1, window - (model?.maxTokens ?? 0));
}

/** The newest results whose mass reaches the protected floor, and at least the
 * newest three. They stay whole and never count as reclaimable. */
function protectionWindow(messages: ToolResultLike[], usableWindow: number): Set<string> {
	const floor = protectionFloor(usableWindow);
	const out = new Set<string>();
	let mass = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult" || !msg.toolCallId || isPlaceholder(msg)) continue;
		if (mass >= floor && out.size >= 3) break;
		mass += messageTokens(msg);
		out.add(msg.toolCallId);
	}
	return out;
}

/** Magic Context's age distance, per message: how many user turns and how much
 * content follow it. A result's own payload cannot age it. */
function farBehindFlags(messages: ToolResultLike[], usableWindow: number): boolean[] {
	const flags = new Array<boolean>(messages.length).fill(false);
	const distance = usableWindow * AGE_DISTANCE_WINDOW_FRACTION;
	let turns = 0;
	let tokens = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "toolResult" && msg.toolCallId && !isPlaceholder(msg)) {
			flags[i] = turns >= AGE_DISTANCE_TURNS || tokens >= distance;
		}
		if (msg.role === "user") turns++;
		tokens += messageTokens(msg);
	}
	return flags;
}

/** Signatures of other extensions that also rewrite `context`. Running two
 * rewriters on the same transcript makes each undo or corrupt the other's
 * placeholders, so if any of these appear we step aside for that session.
 * Match only structural positions — never substrings inside toolResult file reads. */
export function detectForeignRewriter(messages: ToolResultLike[]): string | null {
	for (const msg of messages) {
		const text = textOf(msg).trimStart();
		if (!text) continue;
		if (msg.role === "toolResult") {
			if (/^\[dropped §\d+§\]/.test(text)) return "magic-context";
			if (text.startsWith("[pruned:")) return "pi-condense";
			continue;
		}
		if (/^§\d+§(?:\s|$)/m.test(text) || text.startsWith("<session-history>")) return "magic-context";
		if (text.startsWith("## Conversation History (Lossless Context Management)")) return "pi-lcm";
		if (Array.isArray(msg.content) && msg.content.some((b) => b.type === "toolCall" && b.name === "context_tree_query")) {
			return "pi-condense";
		}
	}
	return null;
}

/** Canonical JSON of tool arguments: sorted keys, undefined properties ignored. */
export function stableArgs(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableArgs(v)}`).join(",")}}`;
}

function isControlPlaneHint(toolName: string): boolean {
	const name = toolName.toLowerCase().replace(/^mcp_/, "");
	return name.startsWith("ctx_") || name === "todowrite" || name === "todoread";
}

export interface TailMeasurement {
	tailTokens: number;
	reclaimableTokens: number;
	reclaimableCount: number;
	reclaimable: ReclaimHint[];
	hints: ReclaimHint[];
	/** Active results that stay addressable by id, including the protected window. */
	addressable: ReclaimHint[];
	userTurn: number;
}

/** The numbers every nudge decision eats: T is the content the provider sees
 * without reasoning, U is every active tool output outside the protected window
 * that is not queued for a drop. Both are in UTF-8-byte tokens. */
export function measureTail(
	messages: ToolResultLike[],
	pruned: Set<string>,
	requested?: Set<string>,
	usableWindow = DEFAULT_USABLE_WINDOW,
): TailMeasurement {
	const protectedSet = protectedIds(messages);
	const windowSet = protectionWindow(messages, usableWindow);
	const queue = requested ?? new Set<string>();
	let tailTokens = 0;
	let reclaimableTokens = 0;
	let userTurn = 0;
	const reclaimable: ReclaimHint[] = [];
	const addressable: ReclaimHint[] = [];
	for (const msg of messages) {
		if (msg.role === "user") userTurn++;
		if (isPlaceholder(msg)) continue;
		tailTokens += messageTokens(msg);
		if (msg.role !== "toolResult" || !msg.toolCallId) continue;
		const id = msg.toolCallId;
		if (pruned.has(id) || protectedSet.has(id)) continue;
		const hint = { id, toolName: msg.toolName ?? "", chars: textLength(msg), tokens: messageTokens(msg) };
		if (!queue.has(id)) addressable.push(hint);
		if (queue.has(id) || msg.isError || windowSet.has(id)) continue;
		reclaimableTokens += hint.tokens;
		reclaimable.push(hint);
	}
	const hints = reclaimable
		.filter((hint) => hint.tokens >= AGE_RECLAIM_MIN_TOKENS && !isControlPlaneHint(hint.toolName))
		.slice(0, REDUCE_HINT_LIMIT);
	return { tailTokens, reclaimableTokens, reclaimableCount: reclaimable.length, reclaimable, hints, addressable, userTurn };
}

export interface PruneOptions {
	pruned: Set<string>;
	/** Queued drops from ctx_reduce; applied when `allowNew` and cleared then. */
	requested?: Set<string>;
	/** False mid tool loop: placeholders replay, but nothing new lands. */
	allowNew?: boolean;
	dryRun?: boolean;
	usableWindow?: number;
}

/** Replace stale tool results with a placeholder, in place.
 * Only tool results are ever touched: user and assistant text is left alone, and
 * a tool result is replaced rather than removed, so call/result pairing and the
 * positions of every other message survive. */
export function pruneMessages(messages: ToolResultLike[], options: PruneOptions): PruneReport {
	const { usableWindow = DEFAULT_USABLE_WINDOW, allowNew = true, dryRun = false, pruned, requested } = options;
	const report: PruneReport = { pruned: 0, replayed: 0, charsSaved: 0, tokensSaved: 0, candidates: 0, queued: 0 };
	const protectedSet = protectedIds(messages);
	const windowSet = protectionWindow(messages, usableWindow);
	const far = farBehindFlags(messages, usableWindow);

	// Newest-first: for duplicate calls the newest result is the one kept whole.
	const seen = new Set<string>();
	const argsById = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && block.id) argsById.set(block.id, `${block.name ?? ""}:${stableArgs(block.arguments)}`);
		}
	}

	const drop = (msg: ToolResultLike, id: string, tokens: number) => {
		report.pruned++;
		report.charsSaved += textLength(msg);
		report.tokensSaved += tokens;
		pruned.add(id);
		requested?.delete(id);
		if (!dryRun) msg.content = [{ type: "text", text: placeholder(id) }];
	};

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || msg.role !== "toolResult" || !msg.toolCallId) continue;
		const id = msg.toolCallId;

		if (pruned.has(id) || isPlaceholder(msg)) {
			// Re-apply the canonical bytes every pass, even if something else edited them.
			if (!dryRun && !isPlaceholder(msg)) msg.content = [{ type: "text", text: placeholder(id) }];
			pruned.add(id);
			report.replayed++;
			continue;
		}
		if (protectedSet.has(id)) {
			requested?.delete(id);
			continue;
		}
		if (msg.isError && !requested?.has(id)) continue;
		const tokens = messageTokens(msg);
		if (requested?.has(id)) {
			if (!allowNew) {
				// Batched: applying a drop mid tool loop changes the prefix on every
				// model call of the loop. All requested drops of one turn land together
				// at the next allowed pass, one bust instead of one per reduce call.
				report.queued++;
				continue;
			}
			// Explicitly requested: no age or size gate. The model named this exact
			// result, so the request itself is the justification.
			drop(msg, id, tokens);
			continue;
		}
		if (windowSet.has(id)) continue;
		const signature = argsById.get(id);
		if (signature) {
			if (seen.has(signature)) {
				if (tokens < AGE_RECLAIM_MIN_TOKENS) continue;
				// An identical later call already returned this; age does not matter.
				report.candidates++;
				if (allowNew) drop(msg, id, tokens);
				continue;
			}
			seen.add(signature);
		}
		if (!far[i]) continue;
		if (tokens < AGE_RECLAIM_MIN_TOKENS) continue;
		report.candidates++;
		if (!allowNew) continue;
		drop(msg, id, tokens);
	}
	return report;
}

// ---------------------------------------------------------------------------
// Recovery: read the original back out of the session entries or session file.
//
// The session entries in SessionManager (or the session JSONL on disk) already
// contain every tool result ever produced, including ones compaction or pruning
// removed from the model's view, so there is nothing to index.
// ---------------------------------------------------------------------------

export interface SessionEntryLike {
	type?: string;
	id?: string;
	timestamp?: string;
	message?: {
		role?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		content?: string | Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }>;
	};
}

export function readSessionEntries(sessionFile: string): SessionEntryLike[] {
	const entries: SessionEntryLike[] = [];
	for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as SessionEntryLike);
		} catch {
			// A partially written trailing line is not a reason to lose the rest.
		}
	}
	return entries;
}

function entriesFor(ctx: {
	sessionManager?: {
		getEntries?: () => unknown[];
		getSessionFile?: () => string | undefined;
	};
}): SessionEntryLike[] | null {
	const inMemory = ctx.sessionManager?.getEntries?.();
	if (Array.isArray(inMemory) && inMemory.length > 0) return inMemory as SessionEntryLike[];
	const file = ctx.sessionManager?.getSessionFile?.();
	if (file) return readSessionEntries(file);
	if (Array.isArray(inMemory)) return inMemory as SessionEntryLike[];
	return null;
}

function entryText(entry: SessionEntryLike): string {
	const msg = entry.message;
	if (!msg) return "";
	// The ids are part of the searchable text: a [pruned <id>] placeholder only
	// names the toolCallId, so searching that id must find its way back here.
	const ids = [msg.toolCallId, entry.id].filter(Boolean).join(" ");
	const content = msg.content;
	if (typeof content === "string") return `${ids}\n${content}`;
	if (!Array.isArray(content)) return ids;
	const body = content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "toolCall") return `${block.name ?? "tool"}(${JSON.stringify(block.arguments ?? {})})`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
	return `${ids}\n${body}`;
}

/** Literal probes: the symbol shapes a natural-language question loses when every
 * word is AND-ed together. "why did the read of config.ts fail" must still find
 * the message that only contains `config.ts`. Each probe also matches alone. */
export function extractProbes(query: string): string[] {
	const probes = new Set<string>();
	const patterns = [
		/\/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/gi, // /slash-commands
		/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+/gi, // kebab-case, snake_case
		/[a-z0-9][a-z0-9_/-]*(?:\.[a-z0-9_-]+)+/gi, // paths, dotted identifiers
		/\b[a-zA-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase / PascalCase
		/\b(?:TS\d{4,}|ERR_[A-Z][A-Z0-9_]*)\b/g, // error codes
		/["`]([^"`]{3,80})["`]/g, // quoted spans
	];
	for (const pattern of patterns) {
		for (const match of query.matchAll(pattern)) {
			const value = match[1] ?? match[0];
			if (value.length >= 3) probes.add(value);
			if (probes.size >= 5) return [...probes];
		}
	}
	return [...probes];
}

export interface SearchHit {
	id: string;
	role: string;
	timestamp?: string;
	score: number;
	snippet: string;
}

export function searchEntries(entries: SessionEntryLike[], query: string, limit = 10): SearchHit[] {
	const q = query.trim();
	if (!q) return [];
	const terms = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_.\-/]+/gu) ?? [])].filter((t) => t.length > 1);
	const probes = extractProbes(q).map((p) => p.toLowerCase());
	const haystacks = entries
		.filter((e) => e.type === "message" && e.id && e.message?.role !== undefined)
		.map((e) => ({ entry: e, text: entryText(e) }));
	const hits: SearchHit[] = [];

	for (const { entry, text } of haystacks) {
		const lower = text.toLowerCase();
		let score = 0;
		if (lower.includes(q.toLowerCase())) score += 100;
		const matchedTerms = terms.filter((t) => lower.includes(t)).length;
		if (terms.length > 0 && matchedTerms === terms.length) score += 40;
		score += matchedTerms * 4;
		for (const probe of probes) if (lower.includes(probe)) score += 25;
		if (score === 0) continue;
		const anchor = probes.find((p) => lower.includes(p)) ?? terms.find((t) => lower.includes(t)) ?? "";
		const at = anchor ? lower.indexOf(anchor) : 0;
		const start = Math.max(0, at - 200);
		hits.push({
			id: entry.id ?? "",
			role: entry.message?.role ?? "",
			timestamp: entry.timestamp,
			score,
			snippet: (start > 0 ? "…" : "") + text.slice(start, start + 600) + (start + 600 < text.length ? "…" : ""),
		});
	}
	return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Extension surface
// ---------------------------------------------------------------------------

interface SessionState {
	pruned: Set<string>;
	requested: Set<string>;
	protectedIds: Set<string>;
	seenContext: boolean;
	lastReport: PruneReport;
	baseline: TailMeasurement;
	nudge: NudgeState;
	lastNudgeReason: string;
	dropsAppliedOnLastPass: boolean;
	agentSettled: boolean;
	/** Allow-new passes held because the batch was not worth a prefix rewrite. */
	heldPasses: number;
	foreignRewriter: string | null;
}

function newSessionState(): SessionState {
	return {
		pruned: new Set<string>(),
		requested: new Set<string>(),
		protectedIds: new Set<string>(),
		seenContext: false,
		lastReport: { pruned: 0, replayed: 0, charsSaved: 0, tokensSaved: 0, candidates: 0, queued: 0 },
		baseline: { tailTokens: 0, reclaimableTokens: 0, reclaimableCount: 0, reclaimable: [], hints: [], addressable: [], userTurn: 0 },
		nudge: newNudgeState(),
		lastNudgeReason: "",
		dropsAppliedOnLastPass: false,
		agentSettled: false,
		heldPasses: 0,
		foreignRewriter: null,
	};
}

function sessionKey(ctx: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } } | undefined): string {
	return ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionManager?.getSessionFile?.() ?? "default";
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const err = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: true });

export function registerContextGuard(pi: ExtensionAPI): void {
	/** Per-session state, keyed by session id (or file path when no id is
	 * exposed). Concurrent sessions in one process — subagents, /fork, /switch —
	 * never share pruned sets, queued drops, or nudge grace. */
	const sessions = new Map<string, SessionState>();
	const stateFor = (ctx: unknown): SessionState => {
		const key = sessionKey(ctx as Parameters<typeof sessionKey>[0]);
		let s = sessions.get(key);
		if (!s) {
			s = newSessionState();
			sessions.set(key, s);
			if (sessions.size > 16) sessions.delete(sessions.keys().next().value as string);
		}
		return s;
	};

	pi.on("agent_settled", async (_event, ctx) => {
		stateFor(ctx).agentSettled = true;
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

	pi.on("before_agent_start", (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return; // ephemeral session: there is no file to search
		event.systemPromptOptions.sections.session_file = sessionFileSection(sessionFile);
	});

	pi.on("session_start", (_event, ctx) => {
		// Rebuild state from the session entries so ctx_reduce drops and stale/duplicate
		// prunes survive /reload and --resume without any external database.
		const s = newSessionState();
		sessions.set(sessionKey(ctx), s);
		let entries: SessionEntryLike[] | null;
		try {
			entries = entriesFor(ctx);
		} catch {
			return;
		}
		if (!entries || entries.length === 0) return;
		const msgs: ToolResultLike[] = [];
		for (const entry of entries) {
			const msg = entry.message as ToolResultLike | undefined;
			if (!msg?.role) continue;
			msgs.push(msg);
			if (msg.role === "toolResult" && msg.toolCallId && isPlaceholder(msg)) {
				s.pruned.add(msg.toolCallId);
			}
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type !== "toolCall" || block.name !== "ctx_reduce") continue;
					const ids = (block.arguments as { ids?: unknown } | undefined)?.ids;
					if (Array.isArray(ids)) {
						for (const id of ids) if (typeof id === "string") s.requested.add(id);
					}
				}
			}
		}
		s.foreignRewriter = detectForeignRewriter(msgs);
		if (s.foreignRewriter) {
			s.requested.clear();
			return;
		}
		const usableWindow = usableWindowFor(ctx.model);
		pruneMessages(msgs, { allowNew: true, pruned: s.pruned, requested: s.requested, dryRun: true, usableWindow });
		s.requested.clear();
		s.protectedIds = protectedIds(msgs);
		s.baseline = measureTail(msgs, s.pruned, undefined, usableWindow);
		if (msgs.some((m) => m.role === "toolResult" && textOf(m).includes(NUDGE_SENTINEL))) {
			s.nudge.lastLevel = nudgeBand(s.baseline.reclaimableTokens, s.baseline.tailTokens);
			s.nudge.lastNudgeU = s.baseline.reclaimableTokens;
			s.nudge.lastFireTurn = s.baseline.userTurn;
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessions.delete(sessionKey(ctx));
	});

	pi.on("context", (event, ctx) => {
		const s = stateFor(ctx);
		const messages = event.messages as unknown as ToolResultLike[];
		s.foreignRewriter ??= detectForeignRewriter(messages);
		if (s.foreignRewriter) {
			// Another extension is already rewriting this transcript; stepping in too
			// would undo or corrupt its placeholders.
			s.lastNudgeReason = `disabled (${s.foreignRewriter} active)`;
			return { messages: event.messages };
		}
		const last = messages[messages.length - 1];
		// New prunes are admitted only at the start of a user turn. Mid-loop the
		// model is comparing against the prefix it already has; changing it then
		// costs a cache bust per tool call instead of one per turn.
		const usableWindow = usableWindowFor(ctx.model);
		let allowNew = last?.role === "user" || s.agentSettled;
		s.agentSettled = false;
		// A batch rewrites the whole message prefix, so it has to be worth it:
		// Magic Context applies at 2% of the usable window, or holds at most three
		// passes. Small batches wait instead of busting the cache for a few tokens.
		if (allowNew) {
			const wouldBe = pruneMessages(messages, {
				allowNew: true,
				pruned: new Set(s.pruned),
				requested: new Set(s.requested),
				dryRun: true,
				usableWindow,
			});
			const worth = wouldBe.tokensSaved >= Math.round(DROP_PRESSURE_FRACTION * usableWindow);
			if (wouldBe.pruned > 0 && !worth && s.heldPasses + 1 < HELD_PASS_LIMIT) {
				s.heldPasses++;
				allowNew = false;
			} else {
				s.heldPasses = 0;
			}
		}
		s.lastReport = pruneMessages(messages, {
			allowNew,
			pruned: s.pruned,
			requested: s.requested,
			dryRun: process.env[DRY_RUN_ENV] === "1",
			usableWindow,
		});
		if (allowNew) s.requested.clear();
		s.dropsAppliedOnLastPass = s.lastReport.pruned > 0;
		s.seenContext = true;
		s.protectedIds = protectedIds(messages);
		s.baseline = measureTail(messages, s.pruned, s.requested, usableWindow);

		// Queued drops from ctx_reduce land at the next agent turn (allowNew).
		// Hold grace pending through the rest of the current tool loop, then capture
		// the post-reduce baseline once the drops have actually been applied.
		if (allowNew && s.nudge.grace && s.nudge.grace.baselineU === null) {
			if (s.lastReport.pruned > 0) {
				s.nudge.grace.baselineU = s.baseline.reclaimableTokens;
				s.nudge.reducedSinceRefresh = false;
			} else {
				// The reduce asked for ids that were not droppable: nothing changed, so
				// there is no compliance to honour and no reason to stay silent.
				s.nudge.grace = null;
				s.nudge.reducedSinceRefresh = false;
			}
		}

		return { messages: event.messages };
	});

	// Channel 1: when a tool result finishes and the reclaimable mass has crossed
	// a band, append the reminder to that result. Appending here means the block
	// is written once, persisted with the result, and replayed byte-identical on
	// every later pass — no anchor, no re-derivation, no cache bust.
	pi.on("tool_result", (event, ctx) => {
		const s = stateFor(ctx);
		if (s.foreignRewriter) return;
		if (event.toolName === "ctx_reduce") {
			s.nudge.reducedSinceRefresh = true;
			s.nudge.grace = { baselineU: null, preLevel: s.nudge.lastLevel };
			return;
		}
		const text = (event.content ?? [])
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		if (!text || text.includes(NUDGE_SENTINEL)) return;
		// A result that just arrived sits inside the protected window, so it adds to
		// T but never to U. U only moves at the next context pass, when older
		// results leave that window.
		s.baseline.tailTokens += estimateTokens(text);
		if (s.nudge.grace && s.nudge.grace.baselineU === null) return; // waiting for the post-reduce measurement
		const verdict = decideNudge(s.nudge, {
			reclaimableTokens: s.baseline.reclaimableTokens,
			tailTokens: s.baseline.tailTokens,
			userTurn: s.baseline.userTurn,
			appliedDropsThisPass: s.dropsAppliedOnLastPass,
		});
		s.lastNudgeReason = `${verdict.reason} (U=${s.baseline.reclaimableTokens} T=${s.baseline.tailTokens})`;
		if (!verdict.fire || !verdict.level) return;
		s.nudge.lastLevel = verdict.level;
		s.nudge.lastNudgeU = s.baseline.reclaimableTokens;
		s.nudge.lastFireTurn = s.baseline.userTurn;
		return {
			content: [
				...(event.content ?? []),
				{
					type: "text" as const,
					text: buildNudgeReminder(verdict, s.baseline.hints, {
						count: s.baseline.reclaimableCount,
						tokens: s.baseline.reclaimableTokens,
					}),
				},
			],
		};
	});

	pi.registerCommand("context-guard", {
		description: "Show what context pruning did (or would do, with PI_CONTEXT_GUARD_DRY_RUN=1)",
		handler: async (_args, ctx) => {
			const s = stateFor(ctx);
			const r = s.lastReport;
			const dry = process.env[DRY_RUN_ENV] === "1" ? " [dry run, nothing changed]" : "";
			ctx.ui.notify(
				`pruned ${r.pruned} results (${r.queued} queued), replayed ${r.replayed}, ~${r.charsSaved} chars reclaimed; ` +
					`tail ~${s.baseline.tailTokens} tok, reclaimable ~${s.baseline.reclaimableTokens} tok, band=${nudgeBand(s.baseline.reclaimableTokens, s.baseline.tailTokens) || "quiet"}; ` +
					`last nudge: ${s.lastNudgeReason || "none"}${dry}`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "ctx_reduce",
		label: "Drop stale tool output",
		description:
			"Drop tool results you no longer need, to shrink the context. Takes tool call ids (the id of the tool call whose output you want gone, or the id from a [pruned <id>] placeholder). " +
			"The original stays in the session file and ctx_expand(id) brings it back, so this is never irreversible. " +
			"Call with no ids to list the largest results currently taking space. The drops are queued and land together at the next pass that can rewrite the prefix, and only when the batch is worth that rewrite, so the cached prefix is never rewritten mid tool loop.",
		parameters: {
			type: "object",
			properties: {
				ids: {
					type: "array",
					items: { type: "string" },
					description: "Tool call ids to drop. Omit to list the largest results still in context, with their ids and sizes.",
				},
			},
		} as unknown as TSchema,
		async execute(_toolCallId, params: { ids?: string[] }, _signal, _onUpdate, ctx: ExtensionContext) {
			const s = stateFor(ctx);
			let active: ReclaimHint[];
			let addressable: ReclaimHint[];
			let protectedSet: Set<string>;
			if (s.seenContext) {
				active = s.baseline.reclaimable.filter((r) => !s.pruned.has(r.id) && !s.requested.has(r.id));
				addressable = s.baseline.addressable.filter((r) => !s.pruned.has(r.id) && !s.requested.has(r.id));
				protectedSet = s.protectedIds;
			} else {
				const contextEntries = (ctx.sessionManager as { buildContextEntries?: () => unknown[] } | undefined)?.buildContextEntries?.();
				let entries: SessionEntryLike[] | null;
				try {
					entries = Array.isArray(contextEntries) && contextEntries.length > 0
						? (contextEntries as SessionEntryLike[])
						: entriesFor(ctx);
				} catch (e) {
					return err(`Cannot read session file: ${(e as Error).message}`);
				}
				if (!entries) return err("No session file: this session is not persisted.");
				const msgs = entries.map((e) => e.message as ToolResultLike | undefined).filter((m): m is ToolResultLike => Boolean(m?.role));
				protectedSet = protectedIds(msgs);
				const usableWindow = usableWindowFor(ctx.model);
				const measured = measureTail(msgs, s.pruned, s.requested, usableWindow);
				addressable = measured.addressable;
				active = measured.reclaimable.filter((r) => r.tokens >= AGE_RECLAIM_MIN_TOKENS);
			}

			if (!params.ids || params.ids.length === 0) {
				const sized = [...active].sort((a, b) => b.chars - a.chars).slice(0, REDUCE_HINT_LIMIT);
				if (sized.length === 0) return ok("No tool results available to drop.");
				return ok(
					"Largest tool results still taking context space:\n" +
						sized.map((r) => `${r.id}  ${r.chars} chars`).join("\n") +
						"\n\nCall ctx_reduce({ids:[...]}) to drop any of these. ctx_expand(id) restores.",
				);
			}

			const known = new Set(addressable.map((r) => r.id));
			const accepted: string[] = [];
			const unknown: string[] = [];
			const already: string[] = [];
			const protectedRejected: string[] = [];
			for (const id of params.ids) {
				if (s.pruned.has(id) || s.requested.has(id)) already.push(id);
				else if (protectedSet.has(id)) protectedRejected.push(id);
				else if (!known.has(id)) unknown.push(id);
				else {
					s.requested.add(id);
					accepted.push(id);
				}
			}
			const parts: string[] = [];
			if (accepted.length) parts.push(`Queued ${accepted.length} result(s) for dropping at the next pass that can rewrite the prefix: ${accepted.join(", ")}. Nothing changes during this tool loop, so the cached prefix stays intact. Recover any of them with ctx_expand(id).`);
			if (already.length) parts.push(`Already dropped: ${already.join(", ")}.`);
			if (protectedRejected.length) parts.push(`Protected (kept in context): ${protectedRejected.join(", ")}.`);
			if (unknown.length) parts.push(`Not found in this session: ${unknown.join(", ")}.`);
			return ok(parts.join(" ") || "Nothing to do.");
		},
	});

	pi.registerTool({
		name: "ctx_expand",
		label: "Expand pruned output",
		description:
			"Return the original content of a pruned tool result or any earlier session entry, from the session file. Use the id from a [pruned <id>] placeholder or a ctx_search hit. Long content is returned in chunks; pass offset to continue.",
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "Tool call id from a [pruned <id>] placeholder, or a session entry id from ctx_search." },
				offset: { type: "number", description: "Character offset to continue from, as given by a previous truncated call." },
			},
			required: ["id"],
		} as unknown as TSchema,
		async execute(_toolCallId, params: { id: string; offset?: number }, _signal, _onUpdate, ctx: ExtensionContext) {
			let entries: SessionEntryLike[] | null;
			try {
				entries = entriesFor(ctx);
			} catch (e) {
				return err(`Cannot read session file: ${(e as Error).message}`);
			}
			if (!entries) return err("No session file: this session is not persisted.");
			// A tool result id is the toolCallId, not the entry id — accept both.
			const matches = entries.filter((e) => e.id === params.id || (e.message?.role === "toolResult" && e.message.toolCallId === params.id));
			const entry = matches[matches.length - 1];
			if (!entry) return err(`No session entry or pruned tool result with id "${params.id}".`);
			const text = entryText(entry);
			const offset = Math.max(0, params.offset ?? 0);
			if (offset >= text.length && text.length > 0) return ok(`Nothing past offset ${offset} (total ${text.length} characters).`);
			const chunk = text.slice(offset, offset + EXPAND_CHAR_BUDGET);
			const next = offset + chunk.length;
			const more = next < text.length ? `\n\n[truncated — ${text.length} characters total, continue with offset=${next}]` : "";
			return ok(chunk + more);
		},
	});

	pi.registerTool({
		name: "ctx_search",
		label: "Search session history",
		description:
			"Search this session's full history, including messages removed from your context by compaction or pruning. Matches exact phrases, all query terms, and literal symbols (paths, identifiers, error codes) individually. Returns entry ids for ctx_expand.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to look for. Include literal names (file paths, symbols, error strings) for the best hits." },
				limit: { type: "number", description: "Maximum hits, default 10." },
			},
			required: ["query"],
		} as unknown as TSchema,
		async execute(_toolCallId, params: { query: string; limit?: number }, _signal, _onUpdate, ctx: ExtensionContext) {
			let entries: SessionEntryLike[] | null;
			try {
				entries = entriesFor(ctx);
			} catch (e) {
				return err(`Cannot read session file: ${(e as Error).message}`);
			}
			if (!entries) return err("No session file: this session is not persisted.");
			const hits = searchEntries(entries, params.query, params.limit ?? 10);
			if (hits.length === 0) return ok("No matches.");
			return ok(
				hits
					.map((h) => `[${h.id}] ${h.role}${h.timestamp ? " " + h.timestamp : ""} (score ${h.score})\n${h.snippet}`)
					.join("\n\n") + `\n\nUse ctx_expand(id) for full content.`,
			);
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerContextGuard(pi);
}
