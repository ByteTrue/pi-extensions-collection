import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerBashTimeout, { registerBashDefaultTimeout } from "./bash-timeout.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type FakeToolCall = {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
};
function harness(register: (pi: ExtensionAPI) => void) {
  const handlers: Record<string, Handler> = {};
  const pi = {
    on(event: string, handler: Handler) {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  register(pi);
  return handlers;
}

const event = (toolName: string, input: Record<string, unknown>): FakeToolCall => ({
  type: "tool_call",
  toolCallId: "t1",
  toolName,
  input,
});

describe("registerBashDefaultTimeout", () => {
  it("injects a 120s default timeout into bash calls that did not pass one", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("bash", { command: "find /" });
    await handlers["tool_call"]?.(call, {});
    expect(call.input).toEqual({ command: "find /", timeout: 120 });
  });

  it("injects a 120s default timeout into powershell calls that did not pass one", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("powershell", { command: "Get-ChildItem /" });
    await handlers["tool_call"]?.(call, {});
    expect(call.input).toEqual({ command: "Get-ChildItem /", timeout: 120 });
  });

  it("leaves an explicitly passed timeout above the default untouched (no 300s hard cap)", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("bash", { command: "npm test", timeout: 1800 });
    await handlers["tool_call"]?.(call, {});
    expect(call.input.timeout).toBe(1800);
  });

  it("clamps only at pi's platform maximum, far above the old cap", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("bash", { command: "npm test", timeout: 99_999_999 });
    await handlers["tool_call"]?.(call, {});
    expect(call.input.timeout).toBe(2_147_483);
  });

  it("respects an explicit timeout at or below the default", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const below = event("bash", { command: "npm run build", timeout: 60 });
    await handlers["tool_call"]?.(below, {});
    expect(below.input.timeout).toBe(60);
    const atDefault = event("bash", { command: "npm run build", timeout: 120 });
    await handlers["tool_call"]?.(atDefault, {});
    expect(atDefault.input.timeout).toBe(120);
  });

  it("turns an explicit zero timeout into 'no timeout' (opencode semantics)", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("bash", { command: "sleep 5", timeout: 0 });
    await handlers["tool_call"]?.(call, {});
    // Pi rejects timeout <= 0; removing it is the built-in's "no timeout".
    expect(call.input).toEqual({ command: "sleep 5" });
  });

  it("treats a negative timeout as absent and injects the 120s default", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("bash", { command: "sleep 5", timeout: -5 });
    await handlers["tool_call"]?.(call, {});
    expect(call.input.timeout).toBe(120);
  });

  it("covers the powershell tool (same schema, same hang risk on Windows)", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("powershell", { command: "Get-ChildItem" });
    await handlers["tool_call"]?.(call, {});
    expect(call.input.timeout).toBe(120);
  });

  it("ignores non-shell tool calls", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("read", { path: "/tmp/x" });
    await handlers["tool_call"]?.(call, {});
    expect(call.input).toEqual({ path: "/tmp/x" });
  });

  it("ignores waitSeconds (not a real powershell parameter — the hook keys only on timeout)", async () => {
    const handlers = harness(registerBashDefaultTimeout);
    const call = event("powershell", { command: "npm run dev", waitSeconds: 5 });
    await handlers["tool_call"]?.(call, {});
    expect(call.input).toEqual({ command: "npm run dev", timeout: 120, waitSeconds: 5 });
  });
});

describe("bash-timeout extension", () => {
  it("registers no tools or commands and leaves tool results untouched", () => {
    const toolNames: string[] = [];
    const commandNames: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      registerCommand(name: string) {
        commandNames.push(name);
      },
      on(event: string) {
        events.push(event);
      },
    } as unknown as ExtensionAPI;

    registerBashTimeout(pi);

    expect(toolNames).toEqual([]);
    expect(commandNames).toEqual([]);
    expect(events).toEqual(["tool_call"]);
  });
});
