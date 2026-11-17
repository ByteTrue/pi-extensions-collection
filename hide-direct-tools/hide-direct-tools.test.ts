import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerHideDirectTools, { ONLY_GUIDELINE } from "./hide-direct-tools.js";

type Handler = (event: any, ctx: any) => any;

function harness(mode?: "on" | "only") {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
    getSettings() {
      return { codemode: mode ? { mode } : undefined };
    },
  } as unknown as ExtensionAPI;
  registerHideDirectTools(pi);

  const call = (toolName: string, parentToolCallId?: string) =>
    handlers["tool_call"]?.(
      { type: "tool_call", toolCallId: parentToolCallId ? "parent/1" : "call-1", toolName, input: {}, parentToolCallId },
      {},
    );
  const start = (options: { promptGuidelines: string[] }) =>
    handlers["before_agent_start"]?.(
      { type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: options },
      {},
    );

  return { call, start };
}

describe("hide-direct-tools", () => {
  it("blocks a top-level call to a hidden tool in only mode, pointing at the script form", async () => {
    const { call } = harness("only");
    const result = await call("read");
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("tools.read");
  });

  it("allows nested calls a codemode script made (parentToolCallId set)", async () => {
    const { call } = harness("only");
    expect(await call("read", "call-1")).toBeUndefined();
  });

  it("allows the codemode tool itself at the top level", async () => {
    const { call } = harness("only");
    expect(await call("codemode")).toBeUndefined();
  });

  it("is a no-op in on mode and when codemode settings are absent", async () => {
    for (const mode of ["on", undefined] as const) {
      const { call } = harness(mode);
      expect(await call("read")).toBeUndefined();
    }
  });

  it("adds the single-entry rule in only mode and nothing otherwise", async () => {
    const options = { promptGuidelines: [] as string[] };
    await harness("only").start(options);
    expect(options.promptGuidelines).toEqual([ONLY_GUIDELINE]);

    const onOptions = { promptGuidelines: [] as string[] };
    await harness("on").start(onOptions);
    expect(onOptions.promptGuidelines).toEqual([]);
  });
});
