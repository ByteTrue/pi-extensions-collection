import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import askUserExtension, { askUserExecute, type AskUserParams, type AskUserToolResult } from "./ask-user.js";

interface UICall {
  method: "select" | "input" | "editor";
  args: unknown[];
}

type ReplyOrQueue<T> = T | T[];

function shiftReply<T>(source: ReplyOrQueue<T> | undefined): T | undefined {
  if (Array.isArray(source)) {
    return source.shift();
  }
  return source;
}

/**
 * Dialog-capable ctx fake: records every ctx.ui call and answers them from
 * `replies` (either a single value or a FIFO queue per method).
 */
function ctxWithRecorder(
  replies: {
    select?: ReplyOrQueue<string | undefined>;
    input?: ReplyOrQueue<string | undefined>;
    editor?: ReplyOrQueue<string | undefined>;
  },
  overrides: Partial<ExtensionContext> = {},
): { ctx: ExtensionContext; calls: UICall[]; working: boolean[] } {
  const calls: UICall[] = [];
  const working: boolean[] = [];
  const selectQueue = Array.isArray(replies.select) ? [...replies.select] : replies.select;
  const inputQueue = Array.isArray(replies.input) ? [...replies.input] : replies.input;
  const editorQueue = Array.isArray(replies.editor) ? [...replies.editor] : replies.editor;

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      async select(title: string, options: string[]) {
        calls.push({ method: "select", args: [title, options] });
        return shiftReply(selectQueue);
      },
      async input(title: string, placeholder?: string) {
        calls.push({ method: "input", args: [title, placeholder] });
        return shiftReply(inputQueue);
      },
      async editor(title: string, prefill?: string) {
        calls.push({
          method: "editor",
          args: prefill !== undefined ? [title, prefill] : [title],
        });
        return shiftReply(editorQueue);
      },
      setWorkingVisible(visible: boolean) {
        working.push(visible);
      },
    },
    ...overrides,
  } as unknown as ExtensionContext;
  return { ctx, calls, working };
}

const flushTicks = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
  let tool:
    | (ToolDefinition & {
        execute: (
          id: string,
          params: unknown,
          s: AbortSignal,
          u: unknown,
          ctx: ExtensionContext,
        ) => Promise<unknown>;
      })
    | undefined;
  const pi = {
    registerTool(t: unknown) {
      tool = t as never;
    },
  } as unknown as ExtensionAPI;
  askUserExtension(pi);
  if (!tool) throw new Error("ask_user tool was not registered");
  return tool;
}


function answeredText(...pairs: [string, string[]][]): string {
  const formatted = pairs
    .map(([question, answers]) => `"${question}"="${answers.length ? answers.join(", ") : "Unanswered"}"`)
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

describe("registration", () => {
  it("registers ask_user with a plain JSON schema for questions[] (no runtime TypeBox symbols)", () => {
    const tool = harness();
    expect(tool.name).toBe("ask_user");
    expect(tool.promptSnippet).toBeTruthy();
    expect((tool.promptGuidelines ?? []).length).toBeGreaterThan(0);
    const parameters = tool.parameters as {
      required?: string[];
      properties?: {
        questions?: {
          items?: { properties?: Record<string, unknown>; required?: string[] };
        };
      };
    };
    expect(Object.getOwnPropertySymbols(parameters)).toHaveLength(0);
    expect(parameters.required).toEqual(["questions"]);
    const itemProps = parameters.properties?.questions?.items?.properties ?? {};
    expect(Object.keys(itemProps)).toEqual(["question", "options", "multiple"]);
    expect(parameters.properties?.questions?.items?.required).toEqual(["question"]);
  });

  it("declares strict JSON-schema sampling like Pi's built-in tools", () => {
    const tool = harness();
    // Without this declaration the model's argument text is unconstrained, and a
    // single stray character after the object surfaces as a broken tool call
    // ("Invalid arguments: ... after JSON at position N"). `prefer` keeps the
    // tool available on providers without strict mode.
    expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
  });

  it("keeps the schema convertible to the strict subset (so `prefer` can engage)", () => {
    // Strict mode requires every property in `required` and rejects unknown
    // keys. The hand-written schema must stay inside that subset or the
    // declaration silently degrades to non-strict on every provider.
    const parameters = harness().parameters as {
      additionalProperties?: unknown;
      properties?: Record<string, unknown>;
    };
    expect(parameters.additionalProperties).toBeUndefined();
    expect(Object.keys(parameters.properties ?? {})).toEqual(["questions"]);
    const items = (
      parameters.properties as {
        questions: { items: { required?: string[]; additionalProperties?: unknown } };
      }
    ).questions.items;
    expect(items.required).toEqual(["question"]);
    expect(items.additionalProperties).toBeUndefined();
  });

  it("normalizes legacy arguments before host schema validation", async () => {
    const tool = harness();
    const legacy = { question: "Runner?", options: [{ label: "vitest" }, { label: "jest" }] };
    const params = validateToolArguments(tool, {
      type: "toolCall", id: "call", name: tool.name,
      arguments: (tool.prepareArguments?.(legacy) ?? legacy) as ToolCall["arguments"],
    });
    const { ctx } = ctxWithRecorder({ select: "vitest" });
    const result = await tool.execute("call", params, new AbortController().signal, () => {}, ctx) as AskUserToolResult;
    expect(result.content).toEqual([{ type: "text", text: answeredText(["Runner?", ["vitest"]]) }]);
  });

  it("enforces the documented batch size at the host boundary", () => {
    const tool = harness();
    for (const length of [0, 5]) {
      expect(() => validateToolArguments(tool, {
        type: "toolCall", id: "call", name: tool.name,
        arguments: { questions: Array.from({ length }, () => ({ question: "Q?" })) },
      })).toThrow();
    }
  });

  it("executes sequentially so one dialog cannot restore the spinner for another", () => {
    expect(harness().executionMode).toBe("sequential");
  });

  it("forwards the tool abort signal to an RPC dialog", async () => {
    const tool = harness();
    const { ctx } = ctxWithRecorder({}, { mode: "rpc" });
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let resolveDialog: ((value: string | undefined) => void) | undefined;
    ctx.ui.select = (_title, _rows, opts) => {
      observedSignal = opts?.signal;
      return new Promise<string | undefined>((resolve) => {
        resolveDialog = resolve;
        opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    };
    const pending = tool.execute(
      "call",
      { questions: [{ question: "Runner?", options: [{ label: "vitest" }] }] },
      controller.signal,
      () => {},
      ctx,
    );
    await flushTicks();

    try {
      controller.abort();
      await flushTicks();
      expect(observedSignal).toBe(controller.signal);
      const result = (await pending) as { content: { text: string }[] };
      expect(result.content[0]!.text).toContain("dismissed");
    } finally {
      resolveDialog?.(undefined);
      await pending;
    }
  });

  it("leads with the trigger condition and includes batching + multi-select + do-not-ask rules", () => {
    const tool = harness();
    expect(
      tool.description.startsWith("When the next step depends on a decision only the user can make"),
    ).toBe(true);
    expect(tool.description).toContain("instead of ending your turn with a prose question");
    expect(tool.description).toContain("multiple: true");
    expect(tool.promptGuidelines).toContain(
      "Prefer ask_user over a prose question whenever your turn would otherwise end with a question only the user can answer",
    );
    expect(tool.promptGuidelines?.some((g) => g.includes("Batch 2-4 independent questions"))).toBe(
      true,
    );
    expect(tool.promptGuidelines?.some((g) => g.includes("multiple: true"))).toBe(true);
    expect(tool.promptGuidelines?.some((g) => g.includes("Never ask what the context"))).toBe(true);
  });
});

describe("askUserExecute — single-select option questions", () => {
  const params: AskUserParams = {
    questions: [
      {
        question: "Which test runner?",
        options: [
          { label: "vitest", description: "repo default" },
          { label: "jest" },
        ],
      },
    ],
  };

  it("composes label — description rows plus the Other row, maps back to the bare label", async () => {
    const { ctx, calls } = ctxWithRecorder({ select: "vitest — repo default" });
    const result = (await askUserExecute(params, ctx)) as { content: { text: string }[] };
    expect(calls).toHaveLength(1);
    const [title, options] = calls[0]!.args as [string, string[]];
    expect(title).toBe("Which test runner?");
    expect(options).toEqual(["vitest — repo default", "jest", "Other (type your answer)"]);
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["vitest"]]));
  });

  it("accepts legacy top-level { question, options } parameters", async () => {
    const { ctx } = ctxWithRecorder({ select: "jest" });
    const result = (await askUserExecute(
      {
        question: "Which test runner?",
        options: [{ label: "vitest" }, { label: "jest" }],
      },
      ctx,
    )) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["jest"]]));
  });

  it("routes the Other row to the freeform path", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: "Other (type your answer)",
      editor: "mocha",
    });
    const result = (await askUserExecute(params, ctx)) as { content: { text: string }[] };
    expect(calls.map((c) => c.method)).toEqual(["select", "editor"]);
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["mocha"]]));
  });

  it.each(["tui", "rpc"] as const)("returns to the options when %s Other input is cancelled", async (mode) => {
    const { ctx, calls } = ctxWithRecorder({
      select: ["Other (type your answer)", "vitest — repo default"],
      ...(mode === "tui" ? { editor: undefined } : { input: undefined }),
    }, { mode });
    const result = await askUserExecute(params, ctx);
    expect(calls.map((call) => call.method)).toEqual(["select", mode === "tui" ? "editor" : "input", "select"]);
    expect(calls[2]!.args).toEqual(calls[0]!.args);
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["vitest"]]));
  });

  it("does not reopen the options when abort cancels Other input", async () => {
    const { ctx, calls } = ctxWithRecorder({ select: ["Other (type your answer)", "vitest"] });
    const controller = new AbortController();
    ctx.ui.editor = async () => {
      controller.abort();
      return undefined;
    };
    const result = await askUserExecute(params, ctx, controller.signal);
    expect(result.content[0]!.text).toContain("dismissed");
    expect(calls.map((call) => call.method)).toEqual(["select"]);
  });

  it("returns the fixed dismiss text when the dialog is cancelled", async () => {
    const { ctx } = ctxWithRecorder({ select: undefined });
    const result = (await askUserExecute(params, ctx)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.content[0]!.text).toContain("dismissed");
    expect(result.isError).toBeUndefined();
  });
});

describe("askUserExecute — multi-select questions (multiple: true)", () => {
  const multiParams: AskUserParams = {
    questions: [
      {
        question: "Which targets?",
        multiple: true,
        options: [
          { label: "ESM", description: "modern Node" },
          { label: "CJS", description: "legacy Node" },
          { label: "Browser" },
        ],
      },
    ],
  };

  it("toggles multiple options, always offers Done, and returns ordered labels", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        "[ ] Browser",
        "[ ] ESM — modern Node",
        "[✓] Browser", // uncheck Browser
        "[ ] CJS — legacy Node",
        "✓ Done (2 selected)",
      ],
    });
    const result = (await askUserExecute(multiParams, ctx)) as { content: { text: string }[] };
    expect(calls).toHaveLength(5);

    // Initial render already offers Done: 0 selected means Unanswered.
    const [firstTitle, firstRows] = calls[0]!.args as [string, string[]];
    expect(firstTitle).toBe("Which targets? (select all that apply)");
    expect(firstRows).toEqual([
      "[ ] ESM — modern Node",
      "[ ] CJS — legacy Node",
      "[ ] Browser",
      "[ ] Other (type your answer)",
      "✓ Done (0 selected)",
    ]);

    // After selecting Browser, Done (1 selected) appears
    const [, secondRows] = calls[1]!.args as [string, string[]];
    expect(secondRows).toEqual([
      "[ ] ESM — modern Node",
      "[ ] CJS — legacy Node",
      "[✓] Browser",
      "[ ] Other (type your answer)",
      "✓ Done (1 selected)",
    ]);

    // Preserves option definition order (ESM, CJS)
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", ["ESM", "CJS"]]));
  });

  it("merges custom Other text into the multi-select checklist and allows unchecking it", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        "[ ] ESM — modern Node",
        "[ ] Other (type your answer)",
        "[✓] Other: Deno", // uncheck custom answer
        "[ ] Other (type your answer)", // re-open Other and enter Bun
        "✓ Done (2 selected)",
      ],
      editor: ["Deno", "Bun"],
    });
    const result = (await askUserExecute(multiParams, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", ["ESM", "Bun"]]));
    // Second editor call receives "Deno" as prefill
    const editorCalls = calls.filter((c) => c.method === "editor");
    expect(editorCalls[0]!.args).toEqual(["Which targets? (select all that apply)"]);
    expect(editorCalls[1]!.args).toEqual(["Which targets? (select all that apply)", "Deno"]);
  });



  it("preserves picked options and a saved custom draft when Other input is cancelled", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        "[ ] ESM — modern Node",
        "[ ] Other (type your answer)",
        "[✓] Other: Deno",
        "[ ] Other: Deno",
        "✓ Done (1 selected)",
      ],
      editor: ["Deno", undefined],
    });
    const result = await askUserExecute(multiParams, ctx);
    const finalRows = calls.filter((call) => call.method === "select").at(-1)!.args[1] as string[];
    expect(finalRows).toContain("[✓] ESM — modern Node");
    expect(finalRows).toContain("[ ] Other: Deno");
    expect(finalRows).toContain("✓ Done (1 selected)");
    expect(calls.filter((call) => call.method === "editor")[1]!.args)
      .toEqual(["Which targets? (select all that apply)", "Deno"]);
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", ["ESM"]]));
  });

  it("does not reopen the checklist when abort cancels Other input", async () => {
    const { ctx, calls } = ctxWithRecorder({ select: ["[ ] Other (type your answer)", "✓ Done (0 selected)"] });
    const controller = new AbortController();
    ctx.ui.editor = async () => {
      controller.abort();
      return undefined;
    };
    const result = await askUserExecute(multiParams, ctx, controller.signal);
    expect(result.content[0]!.text).toContain("dismissed");
    expect(calls.map((call) => call.method)).toEqual(["select"]);
  });

  it("does not duplicate a custom answer that equals an option label after going back", async () => {
    const { ctx } = ctxWithRecorder({
      select: [
        "[ ] Other (type your answer)",
        "✓ Done (1 selected)",
        "← Back to previous question",
        "✓ Done (1 selected)",
        "Yes",
      ],
      editor: "ESM",
    });
    const result = (await askUserExecute(
      {
        questions: [
          { question: "Which targets?", multiple: true, options: [{ label: "ESM" }, { label: "CJS" }] },
          { question: "Publish?", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
      ctx,
    )) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(
      answeredText(["Which targets?", ["ESM"]], ["Publish?", ["Yes"]]),
    );
  });
  it("keeps custom text when returning to a submitted multi-select", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        "[ ] Other (type your answer)", "✓ Done (1 selected)",
        "← Back to previous question", "✓ Done (1 selected)", "Yes",
      ],
      editor: "Deno",
    });
    const result = await askUserExecute({ questions: [
      { question: "Targets?", multiple: true, options: [{ label: "ESM" }, { label: "CJS" }] },
      { question: "Publish?", options: [{ label: "Yes" }, { label: "No" }] },
    ] }, ctx);
    expect((calls.filter((call) => call.method === "select")[3]!.args[1] as string[]))
      .toContain("[✓] Other: Deno");
    expect(result.content[0]!.text).toBe(answeredText(["Targets?", ["Deno"]], ["Publish?", ["Yes"]]));
  });

  it("keeps unsubmitted picks and custom text when going back to an earlier question", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        "Node", "[ ] ESM", "[ ] Other (type your answer)",
        "← Back to previous question", "Bun", "✓ Done (2 selected)",
      ],
      editor: "Deno",
    });
    const result = await askUserExecute({ questions: [
      { question: "Runtime?", options: [{ label: "Node" }, { label: "Bun" }] },
      { question: "Targets?", multiple: true, options: [{ label: "ESM" }, { label: "CJS" }] },
    ] }, ctx);
    const rows = calls.at(-1)!.args[1] as string[];
    expect(rows).toContain("[✓] ESM");
    expect(rows).toContain("[✓] Other: Deno");
    expect(result.content[0]!.text).toBe(answeredText(["Runtime?", ["Bun"]], ["Targets?", ["ESM", "Deno"]]));
  });

  it("lets RPC submit an empty multi-select as Unanswered", async () => {
    const { ctx } = ctxWithRecorder({ select: "✓ Done (0 selected)" }, { mode: "rpc" });
    const result = (await askUserExecute(multiParams, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", []]));
  });
});

describe("askUserExecute — batch questions and back-navigation", () => {
  const batchParams: AskUserParams = {
    questions: [
      {
        question: "Which runtime?",
        options: [{ label: "Node" }, { label: "Bun" }],
      },
      {
        question: "Which formats?",
        multiple: true,
        options: [{ label: "ESM" }, { label: "CJS" }],
      },
      {
        question: "Publish to npm?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  };

  it("lets the user go back from Q2 to revise Q1, and from Q3 to revise multi-select Q2", async () => {
    const { ctx, calls } = ctxWithRecorder({
      select: [
        // Q1: initially pick Bun
        "Bun",
        // Q2: realize Q1 was wrong -> go back to Q1
        "← Back to previous question",
        // Q1 revisit: change to Node
        "Node",
        // Q2: select ESM and confirm
        "[ ] ESM",
        "✓ Done (1 selected)",
        // Q3: go back to Q2 to add CJS
        "← Back to previous question",
        // Q2 revisit: ESM is still checked; add CJS and confirm
        "[ ] CJS",
        "✓ Done (2 selected)",
        // Q3: select Yes
        "Yes",
      ],
    });

    const result = (await askUserExecute(batchParams, ctx)) as { content: { text: string }[] };

    // Q1 initial has no Back row
    expect(calls[0]!.args).toEqual([
      "[1/3] Which runtime?",
      ["Node", "Bun", "Other (type your answer)"],
    ]);
    // Q2 has Back row
    expect((calls[1]!.args as [string, string[]])[1]).toContain("← Back to previous question");
    // Q1 revisit shows current answer in title
    expect((calls[2]!.args as [string, string[]])[0]).toBe(
      "[1/3] Which runtime? (current: Bun)",
    );
    // Q2 revisit after Q3 still has ESM checked
    expect((calls[6]!.args as [string, string[]])[1]).toEqual([
      "[✓] ESM",
      "[ ] CJS",
      "[ ] Other (type your answer)",
      "✓ Done (1 selected)",
      "← Back to previous question",
    ]);

    expect(result.content[0]!.text).toBe(
      answeredText(
        ["Which runtime?", ["Node"]],
        ["Which formats?", ["ESM", "CJS"]],
        ["Publish to npm?", ["Yes"]],
      ),
    );
  });

  it("supports going back from an open Q2 to Q1", async () => {
    const { ctx } = ctxWithRecorder({
      select: [
        "Node", // Q1
        "← Back to previous question", // Q2 -> back to Q1
        "Bun", // Q1 revised
        "Other (type your answer)", // Q2 -> open editor
      ],
      editor: "custom-pkg",
    });

    const result = (await askUserExecute(
      {
        questions: [
          { question: "Runtime?", options: [{ label: "Node" }, { label: "Bun" }] },
          { question: "Package name?" },
        ],
      },
      ctx,
    )) as { content: { text: string }[] };

    expect(result.content[0]!.text).toBe(
      answeredText(["Runtime?", ["Bun"]], ["Package name?", ["custom-pkg"]]),
    );
  });
});

describe("askUserExecute — open questions", () => {
  it("uses the multiline editor in TUI mode", async () => {
    const { ctx, calls } = ctxWithRecorder({ editor: "  do both, see notes  " });
    const result = (await askUserExecute(
      { questions: [{ question: "Anything to add?" }] },
      ctx,
    )) as { content: { text: string }[] };
    expect(calls.map((c) => c.method)).toEqual(["editor"]);
    expect(result.content[0]!.text).toBe(answeredText(["Anything to add?", ["do both, see notes"]]));
  });

  it("uses the input dialog in RPC mode", async () => {
    const { ctx, calls } = ctxWithRecorder({ input: "rpc answer" }, { mode: "rpc" });
    const result = (await askUserExecute({ questions: [{ question: "Q?" }] }, ctx)) as {
      content: { text: string }[];
    };
    expect(calls.map((c) => c.method)).toEqual(["input"]);
    expect(result.content[0]!.text).toBe(answeredText(["Q?", ["rpc answer"]]));
  });

  it("records an empty freeform answer as Unanswered", async () => {
    const { ctx } = ctxWithRecorder({ editor: "   " });
    const result = (await askUserExecute({ questions: [{ question: "Q?" }] }, ctx)) as {
      content: { text: string }[];
    };
    expect(result.content[0]!.text).toBe(answeredText(["Q?", []]));
  });
});

describe.each([false, true])("askUserExecute — option identity (multiple=%s)", (multiple) => {
  it.each([
    { name: "duplicate labels", options: [{ label: "A" }, { label: "A" }] },
    { name: "trimmed duplicate labels with different descriptions", options: [{ label: " A ", description: "first" }, { label: "A", description: "second" }] },
    { name: "a label matching another displayed row", options: [{ label: "A", description: "B" }, { label: "A — B" }] },
    { name: "identical displayed rows from distinct labels", options: [{ label: "A", description: "B — C" }, { label: "A — B", description: "C" }] },
  ])("rejects $name across the full batch before opening UI", async ({ options }) => {
    const { ctx, calls, working } = ctxWithRecorder({ select: "OK" });
    const result = await askUserExecute({ questions: [
      { question: "First?", options: [{ label: "OK" }] },
      { question: "Second?", options, multiple },
    ] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("question 2");
    expect(result.content[0]!.text).toContain("Use unique labels");
    expect(calls).toEqual([]);
    expect(working).toEqual([]);
  });

  it.each([
    "Other (type your answer)", "← Back to previous question",
    "✓ Done (0 selected)", "✓ Done (2 selected)",
    "[ ] Other (type your answer)",
  ])("rejects reserved label %s even with a description", async (label) => {
    const { ctx, calls } = ctxWithRecorder({});
    const result = await askUserExecute({ questions: [{
      question: "Pick?", options: [{ label: ` ${label} `, description: "different description" }], multiple,
    }] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("generated Other/Back/Done row");
    expect(result.content[0]!.text).toContain("Rename");
    expect(calls).toEqual([]);
  });

  it("validates legacy top-level options too", async () => {
    const { ctx, calls } = ctxWithRecorder({});
    const result = await askUserExecute({ question: "Pick?", options: [{ label: "A" }, { label: "A" }], multiple }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("allows repeated descriptions and labels reused in another question", async () => {
    const description = "Other (type your answer)";
    const options = [{ label: "A", description }, { label: "B", description }];
    const replies = multiple ? [`[ ] B — ${description}`, "✓ Done (1 selected)"] : [`B — ${description}`];
    const { ctx } = ctxWithRecorder({ select: [...replies, ...replies] });
    const result = await askUserExecute({ questions: [
      { question: "First?", options, multiple },
      { question: "Second?", options, multiple },
    ] }, ctx);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe(answeredText(["First?", ["B"]], ["Second?", ["B"]]));
  });
});

describe("askUserExecute — checklist row identity", () => {
  it.each(["[ ] A", "[✓] A"])("rejects an option label matching another checkbox row: %s", async (label) => {
    const { ctx, calls } = ctxWithRecorder({});
    const result = await askUserExecute({ questions: [{
      question: "Pick?", options: [{ label: "A" }, { label }], multiple: true,
    }] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Use unique labels");
    expect(calls).toEqual([]);
  });

  it.each(["Other: custom", "[ ] Other: custom", "[✓] Other: custom"])("rejects collisions with a future custom Other row: %s", async (label) => {
    const { ctx, calls } = ctxWithRecorder({});
    const result = await askUserExecute({ questions: [{
      question: "Pick?", options: [{ label }], multiple: true,
    }] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("generated Other/Back/Done row");
    expect(calls).toEqual([]);
  });
});

describe("askUserExecute — guard rails", () => {
  it("fails explicitly when no dialog-capable UI exists", async () => {
    const { ctx } = ctxWithRecorder({}, { hasUI: false });
    const result = (await askUserExecute({ questions: [{ question: "Q?" }] }, ctx)) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No interactive UI");
  });

  it("fails on an empty questions array or blank question", async () => {
    const { ctx } = ctxWithRecorder({});
    const emptyArr = (await askUserExecute({ questions: [] }, ctx)) as { isError?: boolean };
    expect(emptyArr.isError).toBe(true);

    const blankQ = (await askUserExecute({ questions: [{ question: "  " }] }, ctx)) as {
      isError?: boolean;
    };
    expect(blankQ.isError).toBe(true);
  });

  it("rejects more than four questions before opening a dialog", async () => {
    const { ctx, calls } = ctxWithRecorder({ editor: "answer" });
    const result = await askUserExecute({ questions: Array.from({ length: 5 }, () => ({ question: "Q?" })) }, ctx);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("does not open the TUI editor when abort follows an Other selection", async () => {
    const { ctx, calls } = ctxWithRecorder({ editor: "late answer" });
    const controller = new AbortController();
    ctx.ui.select = async () => {
      controller.abort();
      return "Other (type your answer)";
    };
    const result = await askUserExecute({ questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] }, ctx, controller.signal);
    expect(result.content[0]!.text).toContain("dismissed");
    expect(calls).toHaveLength(0);
  });

  it("ignores a freeform answer submitted after the run was aborted", async () => {
    const { ctx } = ctxWithRecorder({});
    const controller = new AbortController();
    ctx.ui.editor = async () => {
      controller.abort();
      return "late answer";
    };
    const result = await askUserExecute({ questions: [{ question: "Q?" }] }, ctx, controller.signal);
    expect(result.content[0]!.text).toContain("dismissed");
  });

  it("falls back to freeform when every option label is blank", async () => {
    const { ctx, calls } = ctxWithRecorder({ editor: "freeform" });
    const result = (await askUserExecute(
      { questions: [{ question: "Q?", options: [{ label: "  " }, { label: "" }] }] },
      ctx,
    )) as { content: { text: string }[] };
    expect(calls.map((c) => c.method)).toEqual(["editor"]);
    expect(result.content[0]!.text).toBe(answeredText(["Q?", ["freeform"]]));
  });
});

describe("askUserExecute — working spinner suppression", () => {
  // Regression guard for a real hang: a dialog left open for 86 minutes while
  // Pi's working spinner re-rendered the whole alt-screen frame every 80ms was
  // enough to wedge Windows Terminal (Application Hang in the event log). Every
  // dialog must therefore run with the spinner hidden, and always restore it.

  const optionParams: AskUserParams = {
    questions: [
      {
        question: "Which test runner?",
        options: [{ label: "vitest" }, { label: "jest" }],
      },
    ],
  };

  it("hides the spinner for a normal pick and restores it afterwards", async () => {
    const { ctx, working } = ctxWithRecorder({ select: "vitest" });
    const result = (await askUserExecute(optionParams, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["vitest"]]));
    expect(working).toEqual([false, true]);
  });

  it("hides the spinner around a freeform answer too", async () => {
    const { ctx, working } = ctxWithRecorder({ editor: "both" });
    const result = (await askUserExecute({ questions: [{ question: "Notes?" }] }, ctx)) as {
      content: { text: string }[];
    };
    expect(result.content[0]!.text).toBe(answeredText(["Notes?", ["both"]]));
    expect(working).toEqual([false, true]);
  });

  it("still restores the spinner when the user dismisses the dialog", async () => {
    const { ctx, working } = ctxWithRecorder({ select: undefined });
    const result = (await askUserExecute(optionParams, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("dismissed");
    // A dismiss that leaked `setWorkingVisible(false)` would kill the spinner
    // for the rest of the session — worse than not fixing the hang at all.
    expect(working).toEqual([false, true]);
  });

  it("hides and restores once per dialog in the Other path (two dialogs, fully symmetric)", async () => {
    const { ctx, working, calls } = ctxWithRecorder({
      select: "Other (type your answer)",
      editor: "mocha",
    });
    const result = (await askUserExecute(optionParams, ctx)) as { content: { text: string }[] };
    expect(calls.map((c) => c.method)).toEqual(["select", "editor"]);
    expect(result.content[0]!.text).toBe(answeredText(["Which test runner?", ["mocha"]]));
    expect(working).toEqual([false, true, false, true]);
    expect(working.filter((v) => v === false)).toHaveLength(2);
    expect(working.filter((v) => v === true)).toHaveLength(2);
    expect(working[0]).toBe(false);
    expect(working.at(-1)).toBe(true);
  });

  it("never touches the spinner outside TUI mode", async () => {
    const select = ctxWithRecorder({ select: "vitest" }, { mode: "rpc" });
    await askUserExecute(optionParams, select.ctx);
    expect(select.working).toEqual([]);

    const freeform = ctxWithRecorder({ input: "rpc answer" }, { mode: "rpc" });
    await askUserExecute({ questions: [{ question: "Q?" }] }, freeform.ctx);
    expect(freeform.working).toEqual([]);
  });

  it("restores the spinner when the dialog throws, and still propagates the error", async () => {
    const { ctx, calls, working } = ctxWithRecorder({});
    const ui = ctx.ui as unknown as {
      select: (title: string, options: string[]) => Promise<string | undefined>;
    };
    ui.select = async (title: string, options: string[]) => {
      calls.push({ method: "select", args: [title, options] });
      throw new Error("dialog exploded");
    };

    await expect(askUserExecute(optionParams, ctx)).rejects.toThrow("dialog exploded");
    expect(working).toEqual([false, true]);
  });
});
