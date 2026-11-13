import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import askUserExtension, { askUserExecute, type AskUserParams } from "./ask-user.js";

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

/**
 * Fake custom-component surface: captures the component so the test can drive
 * raw keys, and answers the next editor/input dialog from `freeform`.
 */
function ctxWithCustom(
  freeform?: string,
): {
  ctx: ExtensionContext;
  send: (data: string) => void;
  render: () => string[];
  editorCalls: number;
} {
  let component:
    | { render?: (width: number) => string[]; handleInput?: (data: string) => void }
    | undefined;
  let editorCalls = 0;
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      custom: async (
        factory: (
          tui: { requestRender: () => void },
          theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
          keybindings: { matches: (data: string, key: string) => boolean },
          done: (value: unknown) => void,
        ) => { render: (width: number) => string[]; handleInput: (data: string) => void },
      ) =>
        new Promise((resolve) => {
          component = factory(
            { requestRender: () => {} },
            { fg: (_color, text) => text, bold: (text) => text },
            {
              matches: (data, key) =>
                (key === "tui.select.up" && data === "up") ||
                (key === "tui.select.down" && data === "down") ||
                (key === "tui.select.confirm" && data === "enter") ||
                (key === "tui.select.cancel" && data === "esc"),
            },
            resolve,
          );
        }),
      async select() {
        throw new Error("select should not be used when custom is available");
      },
      async input() {
        editorCalls += 1;
        return freeform;
      },
      async editor() {
        editorCalls += 1;
        return freeform;
      },
      setWorkingVisible() {},
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    send: (data) => component?.handleInput?.(data),
    render: () => component?.render?.(80) ?? [],
    get editorCalls() {
      return editorCalls;
    },
  };
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
  it("lets RPC submit an empty multi-select as Unanswered", async () => {
    const { ctx } = ctxWithRecorder({ select: "✓ Done (0 selected)" }, { mode: "rpc" });
    const result = (await askUserExecute(multiParams, ctx)) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", []]));
  });
  it("uses the custom TUI component to toggle several options and submit once", async () => {
    const { ctx, send, render } = ctxWithCustom();
    const pending = askUserExecute(multiParams, ctx);
    await flushTicks();
    expect(render().some((line) => line.includes("Which targets?"))).toBe(true);

    send(" "); // toggle ESM
    send("down");
    send(" "); // toggle CJS
    send("enter"); // submit both together

    const result = (await pending) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", ["ESM", "CJS"]]));
  });

  it("opens the freeform editor from the custom Other row and merges the text", async () => {
    const { ctx, send } = ctxWithCustom("Deno");
    const pending = askUserExecute(multiParams, ctx);
    await flushTicks();
    send("down");
    send("down");
    send("down"); // Other row
    send("enter");
    await flushTicks();
    send("enter"); // submit the merged custom answer

    const result = (await pending) as { content: { text: string }[] };
    expect(result.content[0]!.text).toBe(answeredText(["Which targets?", ["Deno"]]));
  });

  it("dismisses when the custom dialog is cancelled", async () => {
    const { ctx, send } = ctxWithCustom();
    const pending = askUserExecute(multiParams, ctx);
    await flushTicks();
    send("esc");
    const result = (await pending) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("dismissed");
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
