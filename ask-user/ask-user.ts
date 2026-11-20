/**
 * ask-user — an ask_user tool for single or batched decision questions,
 * supporting single-select, multi-select, freeform answers, and back-navigation
 * across questions using Pi's built-in dialogs only.
 *
 * Loaded from the root Pi package manifest with no build step. Zero runtime
 * imports — jiti loads TypeScript directly; type-only imports disappear at load time.
 *
 * Why it exists: without it the model's questions arrive as free-form prose in
 * a different shape every session, and the user answers by typing
 * "第一个…第二个…" by hand. One tool with a fixed schema plus promptGuidelines
 * makes the question format stable, and the built-in ctx.ui.select/input/
 * editor dialogs turn each answer into arrow keys + Enter across both TUI and
 * RPC (BySpace) modes.
 *
 * Surface: one ask_user tool taking `questions` (1–4 items, each with
 * `question`, optional `options [{label, description?}]`, and optional
 * `multiple: boolean`). Built-in dialogs only:
 * - Single-select question: `ctx.ui.select` with an always-appended
 *   "Other (type your answer)" row.
 * - Multi-select question (`multiple: true`): `ctx.ui.select` loop toggling
 *   `[✓]` / `[ ]` per option, merging custom `Other` text into the checklist,
 *   and confirming with `✓ Done (N selected)`.
 * - Multi-question flow (`questions.length > 1`): step 2..N includes a
 *   "← Back to previous question" row so the user can return and revise
 *   earlier answers before finishing.
 * - Open question (no options): `ctx.ui.editor` in TUI mode (multiline) and
 *   `ctx.ui.input` elsewhere.
 * - Dismiss (Esc): returns a fixed non-error text so the model falls back to
 *   plain prose; no UI (print/JSON mode) is an explicit error.
 *
 * Every dialog runs with the animated working spinner hidden (see
 * `withoutWorkingSpinner`): a dialog can sit unanswered for an hour, and Pi's
 * spinner re-renders the entire alt-screen frame 12.5 times a second while it
 * does. Known limits of that fix are documented on the helper.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const OTHER_LABEL = "Other (type your answer)";
const BACK_LABEL = "← Back to previous question";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  options?: AskUserOption[];
  multiple?: boolean;
}

export interface AskUserParams {
  questions?: AskUserQuestion[];
  /** Legacy single-question fallback accepted at runtime. */
  question?: string;
  options?: AskUserOption[];
  multiple?: boolean;
}

export interface AskUserToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface NormalizedQuestion {
  question: string;
  options: AskUserOption[];
  multiple: boolean;
}

interface QuestionState {
  answers: string[];
  pickedLabels: Set<string>;
  customText?: string;
  customChecked: boolean;
}

// Hand-written plain JSON Schema (no TypeBox Kind symbols): the artifact must
// stay zero-runtime-import, and Pi's validator has a dedicated plain-schema
// path. Same pattern as subagent's tool parameters.
const askUserParameters = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      description:
        "1-4 decision or clarification questions. Pass 1 item for a single question, or 2-4 items to batch independent decisions in one call.",
      items: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The complete question text shown to the user.",
          },
          options: {
            type: "array",
            description:
              "2-4 concrete answer choices, each {label, description?}. Labels are 1-5 words; description is one line explaining the consequence. Omit for an open question (the user types a free-form answer).",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Unique answer text (1-5 words), e.g. 'Use vitest (Recommended)'. Do not use generated Other/Back/Done row labels.",
                },
                description: {
                  type: "string",
                  description: "One-line explanation of this choice.",
                },
              },
              required: ["label"],
            },
          },
          multiple: {
            type: "boolean",
            description:
              "Set true when the user can select more than one option for this question (multi-select).",
          },
        },
        required: ["question"],
      },
    },
  },
  required: ["questions"],
} as const;

function errorResult(text: string): AskUserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Fixed dismiss text: the model should fall back to prose, not re-ask. */
const DISMISSED =
  "User dismissed the question without answering. Do not immediately re-ask; continue in plain prose or drop the question.";

function dismissedResult(): AskUserToolResult {
  return { content: [{ type: "text", text: DISMISSED }] };
}

function normalizeOptions(raw?: AskUserOption[]): AskUserOption[] {
  return (raw ?? [])
    .map((option) => ({
      label: (option?.label ?? "").trim(),
      description: option?.description?.trim() || undefined,
    }))
    .filter((option) => option.label);
}

function optionIdentityError(questions: NormalizedQuestion[]): string | undefined {
  for (const [questionIndex, question] of questions.entries()) {
    const identities = new Map<string, number>();
    for (const [optionIndex, option] of question.options.entries()) {
      const row = option.description ? `${option.label} — ${option.description}` : option.label;
      // Selectors also accept bare labels/rows, so every accepted spelling must be unambiguous.
      const aliases = new Set([option.label, row, ...(question.multiple ? [`[ ] ${row}`, `[✓] ${row}`] : [])]);
      for (const alias of aliases) {
        const control = alias.replace(/^\[(?: |✓)\] /, "");
        if (control === OTHER_LABEL || control === BACK_LABEL || /^✓ Done \(\d+ selected\)$/.test(control) ||
          (question.multiple && control.startsWith("Other: "))) {
          return `ask_user question ${questionIndex + 1}: option ${optionIndex + 1} (${JSON.stringify(option.label)}) conflicts with a generated Other/Back/Done row. Rename its label or description; these rows are added automatically.`;
        }
        const previous = identities.get(alias);
        if (previous !== undefined && previous !== optionIndex) {
          return `ask_user question ${questionIndex + 1}: options ${previous + 1} and ${optionIndex + 1} share the label or displayed row ${JSON.stringify(alias)}. Use unique labels and unambiguous descriptions; descriptions do not distinguish duplicate labels.`;
        }
        identities.set(alias, optionIndex);
      }
    }
  }
  return undefined;
}

function normalizeQuestions(
  params: AskUserParams,
): { questions: NormalizedQuestion[] } | { error: string } {
  if (Array.isArray(params?.questions)) {
    if (params.questions.length === 0 || params.questions.length > 4) {
      return { error: "ask_user requires 1-4 items in the 'questions' array." };
    }
    const normalized: NormalizedQuestion[] = [];
    for (const item of params.questions) {
      const question = (item?.question ?? "").trim();
      if (!question) {
        return { error: "ask_user requires a non-empty 'question' for every item." };
      }
      const options = normalizeOptions(item?.options);
      normalized.push({
        question,
        options,
        multiple: Boolean(item?.multiple) && options.length > 0,
      });
    }
    return { questions: normalized };
  }

  if (typeof params?.question === "string") {
    const question = params.question.trim();
    if (!question) {
      return { error: "ask_user requires a non-empty 'question'." };
    }
    const options = normalizeOptions(params.options);
    return {
      questions: [
        {
          question,
          options,
          multiple: Boolean(params.multiple) && options.length > 0,
        },
      ],
    };
  }

  return { error: "ask_user requires a non-empty 'questions' array." };
}

/**
 * Run one dialog with the animated working spinner hidden.
 *
 * The spinner (pi-tui Loader) re-renders the whole alt-screen frame every 80ms for as long as
 * the dialog is open. A user can leave an ask_user dialog unanswered for an hour, and 12.5
 * full-transcript frames per second for that long is what wedges Windows Terminal. Nothing on
 * screen changes while we wait for the answer, so the frames are pure cost.
 *
 * Known limits, not fixed here:
 * - Only ask_user dialogs are wrapped. Other extension dialogs (Pi's /model picker,
 *   confirmations, login prompts) still spin while they wait.
 * - The restore re-enables Pi's default. `setWorkingVisible` has no getter, so an extension
 *   that globally hides the spinner would be overridden when this dialog closes (none does
 *   today in this repo); the real fix is upstream: pause the indicator while a dialog is
 *   pushed onto the extension-dialog stack.
 * - The terminal-side root cause is out of our boundary. If Windows Terminal still hangs,
 *   the next step is a newer Windows Terminal / WezTerm, not more patches here.
 */
async function withoutWorkingSpinner<T>(
  ctx: ExtensionContext,
  run: () => Promise<T>,
): Promise<T> {
  // print/JSON/RPC modes have no working indicator to stop.
  if (ctx.mode !== "tui") return run();
  ctx.ui.setWorkingVisible(false);
  try {
    return await run();
  } finally {
    // Cancelled, Esc, thrown dialog: the spinner still comes back.
    ctx.ui.setWorkingVisible(true);
  }
}

/** Show one option list, spinner hidden while it waits for a pick. */
function selectDialog(
  ctx: ExtensionContext,
  title: string,
  rows: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  return withoutWorkingSpinner(ctx, () => ctx.ui.select(title, rows, { signal }));
}

/** Collect a freeform answer: multiline editor in TUI, input dialog elsewhere.
 * `undefined` means the user cancelled (Esc); `""` means they submitted an empty
 * field, which is recorded as Unanswered rather than treated as a cancel. */
async function collectFreeform(
  question: string,
  ctx: ExtensionContext,
  prefill?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  const text = await withoutWorkingSpinner(ctx, () =>
    ctx.mode === "tui"
      ? prefill !== undefined
        ? ctx.ui.editor(question, prefill)
        : ctx.ui.editor(question)
      : ctx.ui.input(question, "Type your answer", { signal }),
  );
  return signal?.aborted || text === undefined ? undefined : text.trim();
}

// ── Multi-select ──────────────────────────────────────────────────────
// A loop of `ctx.ui.select` dialogs re-rendered as a checklist, deliberately not
// a custom component: every dialog here then shares Pi's selector semantics,
// where Enter always means "activate the highlighted row" and never "submit
// everything I have so far". A custom dialog made Enter submit the whole set,
// so a user trained by the other dialogs answered a whole question by accident
// (reported as "选择也是回车,提交也是回车"). Submission is the explicit
// `✓ Done (N selected)` row instead.
type MultiOutcome =
  | { kind: "submit"; values: string[] }
  | { kind: "back" };

function multiSelectValues(
  options: AskUserOption[],
  picked: Set<string>,
  customText: string | undefined,
  customChecked: boolean,
): string[] {
  const values = options.map((option) => option.label).filter((label) => picked.has(label));
  if (customChecked && customText) values.push(customText);
  return values;
}

async function multiSelectDialog(
  ctx: ExtensionContext,
  title: string,
  options: AskUserOption[],
  state: QuestionState,
  allowBack: boolean,
  signal?: AbortSignal,
): Promise<MultiOutcome | undefined> {
  // Keep drafts on the question itself so Back preserves picks and Other text.
  const selected = state.pickedLabels;
  while (true) {
    const custom = state.customText;
    const customOn = state.customChecked && Boolean(custom);
    const optionRows = options.map((option) =>
      option.description ? `${option.label} — ${option.description}` : option.label,
    );
    const checkedRows = options.map((option, index) => {
      const checked = selected.has(option.label);
      return `${checked ? "[✓]" : "[ ]"} ${optionRows[index]}`;
    });
    const otherRow = custom
      ? `${customOn ? "[✓]" : "[ ]"} Other: ${custom}`
      : `[ ] ${OTHER_LABEL}`;
    const count = selected.size + (customOn ? 1 : 0);
    // Always offer Done, including 0 selected: submitting nothing is a valid
    // answer ("Unanswered").
    const doneRow = `✓ Done (${count} selected)`;
    const rows = [...checkedRows, otherRow, doneRow, ...(allowBack ? [BACK_LABEL] : [])];

    const selectedRow = await selectDialog(ctx, title, rows, signal);
    if (selectedRow === undefined) return undefined;
    if (allowBack && selectedRow === BACK_LABEL) return { kind: "back" };
    if (selectedRow === doneRow) {
      return { kind: "submit", values: multiSelectValues(options, selected, custom, customOn) };
    }
    if (selectedRow === otherRow || selectedRow === `[ ] ${OTHER_LABEL}`) {
      if (custom && customOn) {
        state.customChecked = false;
        continue;
      }
      const text = await collectFreeform(title, ctx, custom, signal);
      if (text === undefined) return undefined;
      state.customText = text || undefined;
      state.customChecked = Boolean(text);
      continue;
    }
    const matched = options.find(
      (option, index) => checkedRows[index] === selectedRow || optionRows[index] === selectedRow || option.label === selectedRow,
    );
    if (!matched) return undefined;
    if (selected.has(matched.label)) selected.delete(matched.label);
    else selected.add(matched.label);
  }
}

function formatAnswers(questions: NormalizedQuestion[], states: QuestionState[]): string {
  const formatted = questions
    .map((question, index) => {
      const answers = states[index]?.answers ?? [];
      return `"${question.question}"="${answers.length ? answers.join(", ") : "Unanswered"}"`;
    })
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

function formatQuestionTitle(
  q: NormalizedQuestion,
  index: number,
  total: number,
  state: QuestionState,
): string {
  const base = total > 1 ? `[${index + 1}/${total}] ${q.question}` : q.question;
  if (q.multiple) {
    return `${base} (select all that apply)`;
  }
  if (total > 1 && state.answers.length > 0) {
    return `${base} (current: ${state.answers.join(", ")})`;
  }
  return base;
}

/**
 * Core execution, exported for tests. Assumes dialog-capable ctx fakes.
 */
export async function askUserExecute(
  params: AskUserParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AskUserToolResult> {
  const normalized = normalizeQuestions(params);
  if ("error" in normalized) {
    return errorResult(normalized.error);
  }
  const identityError = optionIdentityError(normalized.questions);
  if (identityError) return errorResult(identityError);
  if (!ctx.hasUI) {
    return errorResult(
      "No interactive UI is available in this mode. Ask the question directly in your reply text instead of calling ask_user.",
    );
  }

  const { questions } = normalized;
  const states: QuestionState[] = questions.map(() => ({
    answers: [],
    pickedLabels: new Set<string>(),
    customText: undefined,
    customChecked: false,
  }));

  let index = 0;
  while (index < questions.length) {
    const q = questions[index]!;
    const state = states[index]!;
    const title = formatQuestionTitle(q, index, questions.length, state);

    // 1. Open question (no options)
    if (q.options.length === 0) {
      if (index === 0) {
        const text = await collectFreeform(title, ctx, state.customText, signal);
        if (text === undefined) return dismissedResult();
        state.customText = text || undefined;
        state.answers = text ? [text] : [];
        index += 1;
        continue;
      }

      const keepRow = state.customText ? `✓ Keep answer: ${state.customText}` : undefined;
      const openRows = [...(keepRow ? [keepRow] : []), OTHER_LABEL, BACK_LABEL];
      const selected = await selectDialog(ctx, title, openRows, signal);
      if (selected === undefined) return dismissedResult();
      if (selected === BACK_LABEL) {
        index -= 1;
        continue;
      }
      if (keepRow && selected === keepRow && state.customText) {
        state.answers = [state.customText];
        index += 1;
        continue;
      }
      const text = await collectFreeform(title, ctx, state.customText, signal);
      if (text === undefined) return dismissedResult();
      state.customText = text || undefined;
      state.answers = text ? [text] : [];
      index += 1;
      continue;
    }

    // 2. Multi-select question: toggle the whole set, then submit once.
    if (q.multiple) {
      const outcome = await multiSelectDialog(
        ctx,
        title,
        q.options,
        state,
        index > 0,
        signal,
      );
      if (!outcome) return dismissedResult();
      if (outcome.kind === "back") {
        index -= 1;
        continue;
      }
      const labels = new Set(q.options.map((option) => option.label));
      const custom = state.customText && outcome.values.includes(state.customText) ? state.customText : undefined;
      // A custom answer that happens to equal an option label is the option, not
      // a second answer; otherwise a back-then-resubmit would duplicate it.
      const customIsOption = custom !== undefined && labels.has(custom);
      state.pickedLabels = new Set(outcome.values.filter((value) => labels.has(value)));
      state.customChecked = Boolean(custom && !customIsOption);
      state.answers = [...new Set(outcome.values)];
      index += 1;
      continue;
    }

    // 3. Single-select question
    const optionRows = q.options.map((option) =>
      option.description ? `${option.label} — ${option.description}` : option.label,
    );
    const rows = [...optionRows, OTHER_LABEL, ...(index > 0 ? [BACK_LABEL] : [])];

    const selected = await selectDialog(ctx, title, rows, signal);
    if (selected === undefined) {
      return dismissedResult();
    }
    if (index > 0 && selected === BACK_LABEL) {
      index -= 1;
      continue;
    }
    if (selected === OTHER_LABEL) {
      const text = await collectFreeform(title, ctx, state.customText, signal);
      if (text === undefined) return dismissedResult();
      state.customText = text || undefined;
      state.answers = text ? [text] : [];
      index += 1;
      continue;
    }

    const optIndex = optionRows.findIndex(
      (row, idx) => row === selected || q.options[idx]?.label === selected,
    );
    const label = (optIndex >= 0 ? q.options[optIndex]?.label : undefined) ?? selected;
    state.answers = [label];
    index += 1;
  }

  return {
    content: [{ type: "text", text: formatAnswers(questions, states) }],
  };
}

export default function askUserExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description:
      "When the next step depends on a decision only the user can make, ask it here instead of ending your turn with a prose question — the user answers by picking options and can go back to revise earlier answers in a multi-question flow. Pass 1-4 items in questions: batch independent decisions into one call, and ask a single question first only when later questions depend on its answer. For each question, pass 2-4 options when choices can be enumerated, set multiple: true when several options can be chosen together, or omit options for a genuinely open question.\n\nUsage notes:\n- An \"Other (type your answer)\" row is always appended; do not include a separate free-form option.\n- Multi-select questions toggle rows and submit from the \"✓ Done (N selected)\" row; nothing submits on its own.\n- With 2+ questions, questions 2..N offer a \"← Back to previous question\" row so the user can revise an earlier answer.\n- A dismissed dialog means no answer — fall back to plain prose once and do not re-ask.",
    promptSnippet:
      "Ask the user 1-4 single- or multi-select decision questions — they pick options instead of typing.",
    promptGuidelines: [
      "Prefer ask_user over a prose question whenever your turn would otherwise end with a question only the user can answer",
      "Batch 2-4 independent questions into one ask_user call; ask a single question first only when the next question depends on its answer",
      "Set multiple: true when the user can pick more than one option; put your recommended option first and append '(Recommended)' to its label",
      "Do not add a free-form option: an 'Other (type your answer)' row is appended automatically",
      "Never ask what the context, the repo, or this session already answered — ask in prose only when you have no options to offer",
    ],
    parameters: askUserParameters as unknown as TSchema,
    prepareArguments(args) {
      const input = args as AskUserParams | null;
      if (input && input.questions === undefined && typeof input.question === "string") {
        return { questions: [{ question: input.question, options: input.options, multiple: input.multiple }] };
      }
      return args;
    },
    // Same declaration as Pi's built-in read/bash/edit/write tools. With strict
    // JSON-schema sampling the provider itself constrains the argument text to a
    // valid object, so the whole class of "Invalid arguments: ... after JSON"
    // failures (trailing text, doubled closing braces, duplicated deltas from a
    // proxy) becomes unrepresentable instead of arriving as a broken tool call.
    // `prefer` falls back to plain non-strict declarations when the provider
    // cannot do strict mode, so no provider loses the tool.
    executionMode: "sequential",
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      _onUpdate: (update: unknown) => void,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const result = await askUserExecute(params as AskUserParams, ctx, signal);
      return { ...result, details: undefined };
    },
  });
}
