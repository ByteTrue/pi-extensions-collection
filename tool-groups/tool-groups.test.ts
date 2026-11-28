import { afterEach, describe, expect, it } from "vitest";
import {
  initTheme, ToolExecutionComponent, createReadToolDefinition, createBashToolDefinition, SessionManager,
  type ExtensionAPI, type ExtensionContext, type ExtensionEvent,
  type ToolRendererResolver, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, ProcessTerminal, type Component, TuiMainScreen, TuiAltScreen, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import toolGroups from "./tool-groups.js";

initTheme("dark", false);
const screens: TUI[] = [];
afterEach(() => { for (const screen of screens.splice(0)) screen.stop(); });

function harness(fullscreen = false, mode: "tui" | "rpc" = "tui") {
  const tui = fullscreen ? new TuiAltScreen(new ProcessTerminal()) : new TuiMainScreen(new ProcessTerminal());
  screens.push(tui);
  const handlers = new Map<string, (event: ExtensionEvent, ctx: ExtensionContext) => unknown>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => unknown }>();
  const resolvers: ToolRendererResolver[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  let session = SessionManager.inMemory();
  let choices: string[] = [];
  let selection: (component: Component) => Promise<void> = async component => { component.handleInput?.("\x1b"); };
  let selector: Component | undefined;
  const notices: string[] = [];
  const downstream: ToolRendererResolver = (name, next) => name === "downstream-only" ? { renderCall: () => new Text("downstream", 0, 0) } : next();
  let expanded = false;
  const widgets = new Map<string, unknown>();
  const ctx = {
    mode, hasUI: mode === "tui", cwd: process.cwd(),
    sessionManager: { buildContextEntries: () => session.buildContextEntries() },
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        let finish!: (value: unknown) => void;
        const result = new Promise(resolve => { finish = resolve; });
        selector = await factory(tui, {} as never, {} as never, finish);
        choices = plain(selector.render(1000)).slice(1).filter(line => /^(→ |  )\d+\./.test(line)).map(line => line.slice(2));
        await selection(selector);
        return result;
      },
      notify: (message: string) => notices.push(message),
      getToolsExpanded: () => expanded,
      setToolsExpanded: (value: boolean) => { expanded = value; },
      setWidget: (key: string, factory: ((ui: TUI) => unknown) | undefined) => {
        if (factory) widgets.set(key, factory(tui));
        else widgets.delete(key);
      },
    },
  } as unknown as ExtensionContext;
  toolGroups({
    on: (name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
    registerToolRenderer: (value: ToolRendererResolver) => { resolvers.push(value); },
    registerCommand: (name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, value),
    registerShortcut: (key: string, value: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, value),
    getSettings: () => ({ terminal: { imageWidthCells: 60 } }),
  } as unknown as ExtensionAPI);
  resolvers.push(downstream);
  const resolve = (name: string, base: () => ToolRenderers | undefined, index = 0): ToolRenderers | undefined =>
    index < resolvers.length ? resolvers[index]!(name, () => resolve(name, base, index + 1)) : base();
  const emit = async (event: ExtensionEvent) => { await handlers.get(event.type)?.(event, ctx); };
  return {
    tui, ctx, emit, widgets, notices,
    get session() { return session; },
    replaceSession: () => { session = SessionManager.inMemory(); },
    choose: (value: typeof selection) => { selection = value; },
    get choices() { return choices; },
    command: () => commands.get("tool-groups")!.handler("", ctx),
    keys: (...keys: string[]) => {
      selection = async component => { for (const key of keys) component.handleInput?.(key); };
    },
    start: () => emit({ type: "session_start", reason: "startup" }),
    toggle: () => shortcuts.get("alt+o")?.handler(ctx),
    row: (name: string, id: string, args = {}, definition?: ToolRenderers) =>
      new ToolExecutionComponent(name, id, args, {}, resolve(name, () => definition), tui, ctx.cwd),
  };
}

let timestamp = 0;
const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: {} });
function assistant(content: unknown[]) {
  return { role: "assistant", content, timestamp: ++timestamp } as Extract<Extract<ExtensionEvent, {type: "message_start"}>["message"], {role: "assistant"}>;
}
const plain = (lines: readonly string[]) => lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

describe("tool groups through the extension entry", () => {
  it("replays only displayed compaction-aware history on resume", async () => {
    const h = harness();
    h.session.appendMessage(assistant([call("hidden", "bash")]));
    const kept = h.session.appendMessage(assistant([{ type: "text", text: "boundary" }, call("kept")]));
    h.session.appendMessage({ role: "toolResult", toolCallId: "kept", toolName: "read", content: [], isError: false, timestamp: ++timestamp });
    h.session.appendCompaction("old calls summarized", kept, 100);
    await h.start();
    expect(plain(h.row("read", "kept").render(100))).toEqual(["", "▸ read: 1 succeeded"]);
    expect(plain(h.row("bash", "hidden").render(100)).join(" ")).not.toContain("▸");
  });

  it("merges persisted history with live messages and reconciles persistence without duplicates", async () => {
    const h = harness();
    h.session.appendMessage(assistant([call("old")]));
    await h.start();
    const live = assistant([call("live", "bash")]);
    await h.emit({ type: "message_start", message: live });
    await h.emit({ type: "tool_execution_end", toolCallId: "live", toolName: "bash", result: {}, isError: false });
    expect(plain(h.row("read", "old").render(100))).toEqual(["", "▸ read: 1 running · bash: 1 succeeded"]);
    h.session.appendMessage(live);
    h.session.appendMessage({ role: "toolResult", toolCallId: "live", toolName: "bash", content: [], isError: false, timestamp: ++timestamp });
    await h.emit({ type: "message_start", message: assistant([call("next", "write")]) });
    expect(plain(h.row("read", "old").render(100))).toEqual(["", "▸ read: 1 running · bash: 1 succeeded · write: 1 running"]);
  });

  it("keeps distinct live messages when their timestamps match persisted messages", async () => {
    const h = harness();
    const persisted = assistant([call("persisted")]);
    h.session.appendMessage(persisted);
    await h.start();
    const live = { ...assistant([call("live", "bash")]), timestamp: persisted.timestamp };
    await h.emit({ type: "message_start", message: live });
    expect(plain(h.row("read", "persisted").render(100))).toEqual(["", "▸ read: 1 running · bash: 1 running"]);
    h.session.appendMessage(live);
    await h.emit({ type: "message_start", message: assistant([call("next", "write")]) });
    expect(plain(h.row("read", "persisted").render(100))).toEqual(["", "▸ read: 1 running · bash: 1 running · write: 1 running"]);
  });

  it("keeps the selected row visible in a long history", async () => {
    const h = harness();
    for (let index = 1; index <= 50; index++) {
      h.session.appendMessage(assistant([{ type: "text", text: "break" }, call(String(index), "tool" + index)]));
    }
    await h.start();
    h.choose(async component => {
      const initial = plain(component.render(80));
      expect(initial.length).toBeLessThanOrEqual(12);
      expect(initial.join(" ")).toContain("→ 50. ▸ tool50: 1 running");
      for (let index = 0; index < 40; index++) component.handleInput?.("\x1b[B");
      const scrolled = plain(component.render(80));
      expect(scrolled.length).toBeLessThanOrEqual(12);
      expect(scrolled.join(" ")).toContain("→ 10. ▸ tool10: 1 running");
      component.handleInput?.("\r");
    });
    await h.command();
    expect(plain(h.row("tool10", "10").render(100))[1]).toContain("▾");
    expect(plain(h.row("tool50", "50").render(100))[1]).toContain("▸");
  });

  it("restores nested metadata and toggles newest-first choices; cancel and stale choices are inert", async () => {
    const h = harness();
    h.session.appendMessage(assistant([call("first", "codemode")]));
    h.session.appendMessage({ role: "toolResult", toolCallId: "first", toolName: "codemode", content: [], isError: false, nestedCalls: { complete: true, calls: [{ id: "first/0", name: "bash", status: "error" }] }, timestamp: ++timestamp });
    h.session.appendMessage(assistant([{ type: "text", text: "separate" }, call("newest", "write")]));
    await h.start();
    expect(plain(h.row("codemode", "first").render(100))).toEqual(["", "▸ bash: 1 failed"]);
    h.keys("\r");
    await h.command();
    expect(h.choices[0]).toBe("2. ▸ write: 1 running");
    expect(plain(h.row("write", "newest").render(100))[1]).toContain("▾");
    h.keys("\x1b");
    await h.command();
    h.choose(async component => {
      await h.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
      component.handleInput?.("\r");
    });
    await h.command();
    expect(plain(h.row("write", "newest").render(100))[1]).toContain("▾");
  });

  it("reconciles restored nested metadata with live outcomes across replay and history changes", async () => {
    const h = harness();
    h.session.appendMessage(assistant([call("wrapper", "codemode")]));
    const snapshot = {
      role: "toolResult" as const, toolCallId: "wrapper", toolName: "codemode", content: [], isError: false, timestamp: ++timestamp,
      nestedCalls: { complete: false, calls: [
        { id: "child", name: "read", status: "unfinished" as const },
        { id: "stale", name: "bash", status: "ok" as const },
      ] },
    };
    h.session.appendMessage(snapshot);
    await h.start();
    const row = h.row("codemode", "wrapper");
    expect(plain(row.render(120))).toEqual(["", "▸ read: 1 running · bash: 1 succeeded (incomplete)"]);
    await h.toggle();
    await h.emit({ type: "tool_execution_end", toolCallId: "child", parentToolCallId: "wrapper", toolName: "read", result: {}, isError: false });
    await h.emit({ type: "tool_execution_end", toolCallId: "stale", parentToolCallId: "wrapper", toolName: "bash", result: {}, isError: true });
    // A restored child identity also routes deeper live events to the wrapper.
    await h.emit({ type: "tool_execution_end", toolCallId: "extra", parentToolCallId: "child", toolName: "write", result: {}, isError: false });
    await h.emit({ type: "message_start", message: snapshot });
    await h.emit({ type: "message_end", message: snapshot });
    await h.command();
    const expected = "▾ read: 1 succeeded · bash: 1 failed · write: 1 succeeded (incomplete)";
    expect(plain(row.render(120))[1]).toBe(expected);
    expect(h.choices).toEqual(["1. " + expected]);
    expect(h.row("read", "child").render(120).length).toBeGreaterThan(0);

    h.replaceSession();
    h.session.appendMessage(assistant([call("wrapper", "codemode")]));
    h.session.appendMessage(snapshot);
    await h.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
    expect(plain(row.render(120))[1]).toBe("▾ read: 1 running · bash: 1 succeeded (incomplete)");
  });

  it("does nothing for empty history and non-TUI command contexts", async () => {
    const empty = harness(); await empty.start();
    await empty.command();
    expect(empty.choices).toEqual([]);
    const rpc = harness(false, "rpc");
    await rpc.start();
    rpc.session.appendMessage(assistant([call("rpc-call")]));
    await rpc.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
    await rpc.command();
    expect(rpc.choices).toEqual([]);
  });

  it("discards live calls when displayed history changes", async () => {
    const h = harness(); await h.start();
    await h.emit({ type: "message_start", message: assistant([call("abandoned")]) });
    expect(plain(h.row("read", "abandoned").render(100))).toContain("▸ read: 1 running");
    h.replaceSession();
    h.session.appendMessage(assistant([call("branch")]));
    await h.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });
    expect(plain(h.row("read", "abandoned").render(100)).join(" ")).not.toContain("▸");
    expect(plain(h.row("read", "branch").render(100))).toEqual(["", "▸ read: 1 running"]);
  });

  it("selects with arrows and Enter and cancels with Escape in regular scrollback", async () => {
    const h = harness();
    h.session.appendMessage(assistant([call("first")]));
    h.session.appendMessage(assistant([{ type: "text", text: "break" }, call("second", "write")]));
    h.session.appendMessage(assistant([{ type: "text", text: "break" }, call("third", "bash")]));
    await h.start();
    h.keys("\x1b[B", "\x1b[B", "\x1b[A", "\r");
    await h.command();
    expect(h.choices.map(choice => choice.slice(5))).toEqual(["bash: 1 running", "write: 1 running", "read: 1 running"]);
    expect(plain(h.row("write", "second").render(100))[1]).toContain("▾");
    expect(plain(h.row("bash", "third").render(100))[1]).toContain("▸");
    h.keys("\x1b[B", "\x1b");
    await h.command();
    expect(plain(h.row("write", "second").render(100))[1]).toContain("▾");
  });

  it("rebuilds after compaction, tree navigation, and session switch without leaking overlays", async () => {
    const h = harness();
    const old = h.session.appendMessage(assistant([call("old", "bash")]));
    const kept = h.session.appendMessage(assistant([{ type: "text", text: "boundary" }, call("kept")]));
    await h.start();
    await h.emit({ type: "message_start", message: assistant([call("unpersisted", "write")]) });
    await h.emit({ type: "tool_execution_end", toolCallId: "unpersisted", toolName: "write", result: {}, isError: true });
    const compactId = h.session.appendCompaction("summary", kept, 100);
    await h.emit({ type: "session_compact", compactionEntry: h.session.getEntry(compactId)!, fromExtension: false } as ExtensionEvent);
    h.keys("\x1b"); await h.command();
    expect(h.choices).toEqual(["1. ▸ read: 1 running"]);
    h.session.branch(old);
    await h.emit({ type: "session_tree", newLeafId: old, oldLeafId: compactId });
    await h.command();
    expect(h.choices).toEqual(["1. ▸ bash: 1 running"]);
    h.choose(async component => {
      h.replaceSession();
      h.session.appendMessage(assistant([call("old", "write")]));
      await h.emit({ type: "session_start", reason: "resume" });
      component.handleInput?.("\r");
    });
    await h.command();
    expect(plain(h.row("write", "old").render(100))).toEqual(["", "▸ write: 1 running"]);
    expect(plain(h.row("write", "unpersisted").render(100)).join(" ")).not.toContain("▸");
  });

  it("folds adjacent calls into one live summary and opens native text with Alt+O", async () => {
    const h = harness();
    await h.start();
    await h.emit({ type: "message_start", message: assistant([call("a"), call("b", "bash")]) });
    const a = h.row("read", "a");
    const b = h.row("bash", "b");
    expect(plain([...a.render(100), ...b.render(100)])).toEqual(["", "▸ read: 1 running · bash: 1 running"]);
    await h.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", result: {}, isError: true });
    expect(plain(a.render(100))).toEqual(["", "▸ read: 1 running · bash: 1 failed"]);
    expect(h.widgets.size).toBe(0);
    await h.toggle();
    const native = new ToolExecutionComponent("read", "a", {}, {}, undefined, h.tui, h.ctx.cwd);
    const output = a.render(100).slice();
    output.splice(1, 1);
    expect(output).toEqual(native.render(100));
    expect(b.render(100).length).toBeGreaterThan(0);
  });
  it("chains downstream resolvers and leaves RPC rendering untouched", async () => {
    const h = harness(false, "rpc");
    await h.start();
    await h.emit({ type: "message_start", message: assistant([call("native")]) });
    const definition: ToolRenderers = { renderCall: () => new Text("original", 0, 0) };
    const output = h.row("native", "native", {}, definition).render(80);
    const baseline = new ToolExecutionComponent("native", "native", {}, {}, definition, h.tui, h.ctx.cwd).render(80);
    expect(output).toEqual(baseline);
    const downstream = h.row("downstream-only", "outside");
    expect(plain(downstream.render(80)).join(" ")).toContain("downstream");
  });

  it("keeps source order across streaming boundaries and tool completions before persistence", async () => {
    const h = harness();
    await h.start();
    const stream = async (content: unknown[]) => h.emit({
      type: "message_update", message: assistant(content),
      assistantMessageEvent: { type: "start", partial: {} },
    } as unknown as ExtensionEvent);
    await h.emit({ type: "message_start", message: assistant([]) });
    await stream([call("a"), call("b"), { type: "text", text: "explain" }, call("c", "bash"), { type: "thinking", thinking: "reason" }, call("d", "write")]);
    const rows = [h.row("read", "a"), h.row("read", "b"), h.row("bash", "c"), h.row("write", "d")];
    const summaries = () => plain(rows.flatMap(row => row.render(120)));
    expect(summaries()).toEqual(["", "▸ read: 2 running", "", "▸ bash: 1 running", "", "▸ write: 1 running"]);
    await h.toggle();
    await stream([call("a"), call("b"), { type: "text", text: "explain" }, call("c", "bash"), { type: "thinking", thinking: "reason" }, call("d", "write"), call("e", "write")]);
    await h.emit({ type: "tool_execution_end", toolCallId: "b", toolName: "read", result: {}, isError: true });
    await h.emit({ type: "tool_execution_end", toolCallId: "a", toolName: "read", result: {}, isError: false });
    await h.emit({ type: "tool_execution_end", toolCallId: "d/nested", parentToolCallId: "d", toolName: "read", result: {}, isError: false });
    expect(plain(rows[0]!.render(120))).toEqual(["", "▸ read: 1 succeeded, 1 failed"]);
    expect(plain(rows[3]!.render(120))[1]).toBe("▾ write: 2 running");
    // A tool-only assistant continuation joins the same run; a user message breaks it.
    await h.emit({ type: "message_start", message: assistant([call("f", "write")]) });
    expect(plain(rows[3]!.render(120))[1]).toBe("▾ write: 3 running");
    await h.emit({ type: "message_start", message: { role: "user", content: "next", timestamp: ++timestamp } });
    await h.emit({ type: "message_start", message: assistant([call("g", "bash")]) });
    expect(plain(h.row("bash", "g").render(120))).toEqual(["", "▸ bash: 1 running"]);
    await h.toggle();
    expect(plain(rows[3]!.render(120))[1]).toBe("▾ write: 3 running");
    await h.emit({ type: "session_start", reason: "new" });
    await h.emit({ type: "message_start", message: assistant([call("new")]) });
    expect(plain(h.row("read", "new").render(120))).toEqual(["", "▸ read: 1 running"]);
  });

  it("summarizes live nested executions once and reconciles persisted metadata", async () => {
    const h = harness(); await h.start();
    const message = assistant([call("wrapper", "codemode")]);
    await h.emit({ type: "message_start", message });
    const row = h.row("codemode", "wrapper");
    await h.emit({ type: "tool_execution_start", toolCallId: "nested-1", parentToolCallId: "wrapper", toolName: "read", args: {} });
    expect(plain(row.render(100))).toEqual(["", "▸ read: 1 running"]);
    await h.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as ExtensionEvent);
    expect(plain(row.render(100))).toEqual(["", "▸ read: 1 running"]);
    await h.emit({ type: "tool_execution_end", toolCallId: "nested-1", parentToolCallId: "wrapper", toolName: "read", result: {}, isError: false });
    await h.emit({ type: "tool_execution_start", toolCallId: "nested-2", parentToolCallId: "wrapper", toolName: "bash", args: {} });
    await h.emit({ type: "tool_execution_end", toolCallId: "nested-2", parentToolCallId: "wrapper", toolName: "bash", result: {}, isError: true });
    expect(plain(row.render(100))).toEqual(["", "▸ read: 1 succeeded · bash: 1 failed"]);
    const result = { role: "toolResult" as const, toolCallId: "wrapper", toolName: "codemode", content: [], isError: false, timestamp: ++timestamp, nestedCalls: {
      complete: true, calls: [
        { id: "nested-1", name: "read", status: "ok" as const },
        { id: "nested-2", name: "bash", status: "error" as const },
      ],
    } };
    await h.emit({ type: "message_end", message: result });
    expect(plain(row.render(100))).toEqual(["", "▸ read: 1 succeeded · bash: 1 failed"]);
    const native = new ToolExecutionComponent("codemode", "wrapper", {}, {}, undefined, h.tui, h.ctx.cwd);
    const output = { content: [{ type: "text" as const, text: "result" }], isError: false };
    row.updateResult(output); native.updateResult(output);
    await h.toggle();
    const actual = [...row.render(100)]; actual.splice(1, 1);
    expect(actual).toEqual(native.render(100));
    await h.emit({ type: "message_start", message: { role: "user", content: "restore", timestamp: ++timestamp } });
    const restoredHost = harness(); await restoredHost.start();
    await restoredHost.emit({ type: "message_start", message });
    const restored = restoredHost.row("codemode", "wrapper");
    await restoredHost.emit({ type: "message_start", message: result });
    expect(plain(restored.render(100))).toEqual(["", "▸ read: 1 succeeded · bash: 1 failed"]);
  });

  it("keeps completed outcomes through duplicate starts, updates and recursive calls", async () => {
    const h = harness(); await h.start();
    const message = assistant([call("wrapper", "codemode"), call("sibling", "write")]);
    await h.emit({ type: "message_start", message });
    const row = h.row("codemode", "wrapper");
    const start = { type: "tool_execution_start" as const, toolCallId: "child", parentToolCallId: "wrapper", toolName: "read", args: {} };
    await h.emit(start);
    await h.emit({ ...start, type: "tool_execution_end", result: {}, isError: false });
    await h.emit(start);
    expect(plain(row.render(120))[1]).toBe("▸ read: 1 succeeded · write: 1 running");
    await h.emit({ ...start, type: "tool_execution_update", partialResult: {} });
    await h.emit({ ...start, toolCallId: "grandchild", parentToolCallId: "child", toolName: "bash" });
    await h.emit({ ...start, type: "tool_execution_end", toolCallId: "grandchild", parentToolCallId: "child", toolName: "bash", result: {}, isError: true });
    await h.emit({ type: "message_update", message, assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as ExtensionEvent);
    expect(plain(row.render(120))[1]).toBe("▸ read: 1 succeeded · bash: 1 failed · write: 1 running");
    expect(h.row("write", "sibling").render(120)).toEqual([]);
  });

  it("counts codemode itself when no nested calls are reported", async () => {
    const h = harness(); await h.start();
    await h.emit({ type: "message_start", message: assistant([call("wrapper", "codemode")]) });
    const row = h.row("codemode", "wrapper");
    expect(plain(row.render(100))[1]).toBe("▸ codemode: 1 running");
    await h.emit({ type: "message_end", message: { role: "toolResult", toolCallId: "wrapper", toolName: "codemode", content: [{ type: "text", text: "read: failed" }], isError: true, timestamp: ++timestamp, nestedCalls: { calls: [], complete: true } } });
    expect(plain(row.render(100))[1]).toBe("▸ codemode: 1 failed");
  });

  it("retains completed live calls beyond a capped persisted snapshot", async () => {
    const h = harness(); await h.start();
    await h.emit({ type: "message_start", message: assistant([call("wrapper", "codemode")]) });
    const row = h.row("codemode", "wrapper");
    const calls = Array.from({ length: 257 }, (_, i) => ({ id: "child-" + i, name: "read", status: "ok" as const }));
    for (const child of calls) {
      const event = { toolCallId: child.id, parentToolCallId: "wrapper", toolName: child.name };
      await h.emit({ ...event, type: "tool_execution_start", args: {} });
      await h.emit({ ...event, type: "tool_execution_end", result: {}, isError: false });
    }
    await h.emit({ type: "message_end", message: {
      role: "toolResult", toolCallId: "wrapper", toolName: "codemode", content: [], isError: false, timestamp: ++timestamp,
      nestedCalls: { complete: false, calls: [{ ...calls[0]!, status: "unfinished" }, ...calls.slice(1, 256)] },
    } });
    expect(plain(row.render(100))).toEqual(["", "▸ read: 257 succeeded (incomplete)"]);
  });

  it("keeps known nested calls but marks capped metadata incomplete", async () => {
    const h = harness(); await h.start();
    const message = assistant([call("wrapper", "codemode")]);
    await h.emit({ type: "message_start", message });
    const row = h.row("codemode", "wrapper");
    const result = { role: "toolResult" as const, toolCallId: "wrapper", toolName: "codemode", content: [], isError: false, timestamp: ++timestamp, nestedCalls: {
      complete: false, calls: [{ id: "reported", name: "read", status: "unfinished" as const }],
    } };
    await h.emit({ type: "message_end", message: result });
    expect(plain(row.render(100))).toEqual(["", "▸ read: 1 running (incomplete)"]);
    await h.emit({ type: "message_start", message: { role: "user", content: "empty capped", timestamp: ++timestamp } });
    await h.emit({ type: "message_start", message: assistant([call("empty", "codemode")]) });
    const empty = h.row("codemode", "empty");
    await h.emit({ type: "message_end", message: { ...result, toolCallId: "empty", nestedCalls: { complete: false, calls: [] } } });
    expect(plain(empty.render(100))).toEqual(["", "▸ codemode (incomplete)"]);
  });

  it("marks calls skipped by an aborted or errored assistant response failed", async () => {
    const h = harness(); await h.start();
    const message = { ...assistant([call("skipped")]), stopReason: "aborted" } as ReturnType<typeof assistant>;
    await h.emit({ type: "message_start", message });
    const row = h.row("read", "skipped");
    await h.emit({ type: "message_end", message });
    expect(plain(row.render(80))).toEqual(["", "▸ read: 1 failed"]);
  });

  it("toggles only summary clicks and preserves native body clicks, offsets, drag and wheel", async () => {
    const h = harness(true);
    await h.start();
    await h.emit({ type: "message_start", message: assistant([call("a", "unknown"), call("b", "custom")]) });
    const a = h.row("unknown", "a");
    const native = new ToolExecutionComponent("unknown", "a", {}, {}, undefined, h.tui, h.ctx.cwd);
    const result = { content: [{ type: "text" as const, text: Array.from({length: 25}, (_, i) => "line " + i).join("\n") }], isError: false };
    for (const row of [a, native]) row.updateResult(result);
    const event = (row: ToolExecutionComponent, y: number, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent => ({
      type, button: "left", x: 2, y, screenX: 12, screenY: y + 10,
      width: 100, height: row.render(100).length, shift: false, alt: false, ctrl: false, clickCount: 1,
    });
    for (const type of ["press", "drag", "release", "wheel"] as const) {
      expect(a.handleMouse(event(a, 1, type))?.handled).toBeFalsy();
      expect(plain(a.render(100))[1]).toContain("▸");
    }
    expect(a.handleMouse(event(a, 1))?.handled).toBe(true);
    expect(plain(a.render(100))[1]).toContain("▾");
    expect(a.handleMouse(event(a, 3))?.handled).toBe(native.handleMouse(event(native, 2))?.handled);
    const expanded = [...a.render(100)]; expanded.splice(1, 1);
    expect(expanded).toEqual(native.render(100));
    // Streaming doesn't overwrite the per-row expansion chosen by that click.
    for (const row of [a, native]) row.updateResult(result, true);
    const updated = [...a.render(100)]; updated.splice(1, 1);
    expect(updated).toEqual(native.render(100));
    let coordinates: number[] = [];
    const definition: ToolRenderers = { renderShell: "self", renderCall: () => new Text("custom", 0, 0), renderResult: () => ({
      render: () => ["result body"], invalidate() {},
      handleMouse: mouse => { coordinates = [mouse.x, mouse.y, mouse.height, mouse.screenX, mouse.screenY]; return { handled: true }; },
    }) };
    const b = h.row("custom", "b", {}, definition);
    const baseline = new ToolExecutionComponent("custom", "b", {}, {}, definition, h.tui, h.ctx.cwd);
    for (const row of [b, baseline]) row.updateResult(result);
    baseline.handleMouse(event(baseline, 2));
    const expected = coordinates;
    b.handleMouse(event(b, 2));
    expect(coordinates).toEqual(expected);
    expect(b.render(100)).toEqual(baseline.render(100));
    a.handleMouse(event(a, 1));
    expect(b.render(100)).toEqual([]);
  });

  it("distinguishes global expansion overrides from native per-row expansion", async () => {
    const h = harness(); await h.start();
    await h.emit({ type: "message_start", message: assistant([call("a"), { type: "text", text: "boundary" }, call("b")]) });
    const a = h.row("read", "a"); const b = h.row("read", "b");
    a.setExpanded(true);
    expect(plain(a.render(100))[1]).toContain("▸");
    await h.toggle();
    expect(plain(b.render(100))[1]).toContain("▾");
    h.ctx.ui.setToolsExpanded(true);
    for (const row of [a, b]) row.setExpanded(true);
    expect(plain(a.render(100))[1]).toContain("▾");
    await h.toggle();
    b.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
    expect(plain(b.render(100))[1]).toContain("▸");
    h.ctx.ui.setToolsExpanded(false);
    for (const row of [a, b]) row.setExpanded(false);
    expect(plain(a.render(100))[1]).toContain("▸");
    expect(plain(b.render(100))[1]).toContain("▸");
  });

  it("preserves native fallback slots, state and lifecycle at narrow and wide widths", async () => {
    const h = harness();
    await h.start();
    const stateful: ToolRenderers = {
      renderCall(args, _theme, context) {
        context.state.label ??= "kept";
        const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
        text.setText(JSON.stringify([args, context.state.label, context.executionStarted, context.argsComplete, context.outputPad]));
        return text;
      },
      renderResult(_result, _options, _theme, context) {
        const text = context.lastComponent as Text | undefined ?? new Text("", 0, 0);
        text.setText(JSON.stringify([context.state.label, context.args, context.isPartial, context.isError, context.durationMs, context.expanded, context.showImages]) + "\n" + context.keyHint("app.tools.expand", "expand"));
        return text;
      },
    };
    const cases: [string, ToolRenderers | undefined][] = [
      ["read", createReadToolDefinition(h.ctx.cwd) as ToolRenderers], ["bash", createBashToolDefinition(h.ctx.cwd) as ToolRenderers],
      ["unknown", undefined], ["empty", {}], ["call-only", { renderCall: stateful.renderCall }],
      ["result-only", { renderResult: stateful.renderResult }],
      ["throwing", { renderCall: () => { throw Error("call"); }, renderResult: () => { throw Error("result"); } }],
      ["stateful", stateful], ["self", { ...stateful, renderShell: "self" }], ["codemode", stateful],
    ];
    for (const [name, definition] of cases) {
      const id = name;
      const args = { path: "sample.ts", command: "echo hello" };
      await h.emit({ type: "message_start", message: { role: "user", content: "next case", timestamp: ++timestamp } });
      await h.emit({ type: "message_start", message: assistant([call(id, name)]) });
      const grouped = h.row(name, id, args, definition);
      const native = new ToolExecutionComponent(name, id, args, {}, definition, h.tui, h.ctx.cwd);
      await h.toggle();
      const compare = (stage: string) => {
        for (const width of [22, 80, 120]) {
          const actual = [...grouped.render(width)];
          actual.splice(1, 1);
          expect(actual, name + ":" + stage + ":" + width).toEqual(native.render(width));
        }
      };
      compare("initial");
      for (const row of [grouped, native]) row.updateArgs({ ...args, extra: "stream delta" });
      compare("args");
      for (const row of [grouped, native]) { row.setArgsComplete(); row.markExecutionStarted(); }
      compare("started");
      const result = { content: [{ type: "text" as const, text: Array.from({length: 25}, (_, i) => "line " + i).join("\n") }], details: {}, isError: false, durationMs: 1234 };
      for (const partial of [true, false]) {
        for (const row of [grouped, native]) row.updateResult(result, partial);
        if (name === "codemode" && partial) {
          await h.emit({ type: "tool_execution_start", toolCallId: "child", parentToolCallId: id, toolName: "read", args: {} });
          await h.emit({ type: "message_update", message: assistant([call(id, name)]), assistantMessageEvent: { type: "text_start", contentIndex: 0 } } as unknown as ExtensionEvent);
          expect(plain(grouped.render(120))[1]).toBe("▾ read: 1 running");
          await h.toggle();
          await h.emit({ type: "tool_execution_end", toolCallId: "child", parentToolCallId: id, toolName: "read", result: {}, isError: true });
          expect(plain(grouped.render(120))[1]).toBe("▸ read: 1 failed");
          await h.toggle();
        }
        compare(partial ? "partial" : "final");
      }
      for (const expanded of [true, false]) {
        for (const row of [grouped, native]) row.setExpanded(expanded);
        compare("expanded " + expanded);
      }
      for (const row of [grouped, native]) row.updateResult({ ...result, isError: true });
      compare("error");
      for (const row of [grouped, native]) { row.setOutputPad(0); row.setShowImages(false); }
      compare("settings");
      for (const row of [grouped, native]) row.invalidate();
      compare("invalidated");
    }
  });
});
