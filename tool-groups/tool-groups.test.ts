import { afterEach, describe, expect, it } from "vitest";
import {
  initTheme, ToolExecutionComponent, createReadToolDefinition, createBashToolDefinition,
  type ExtensionAPI, type ExtensionContext, type ExtensionEvent,
  type ToolRendererResolver, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, ProcessTerminal, TuiMainScreen, TuiAltScreen, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
  const downstream: ToolRendererResolver = (name, next) => name === "downstream-only" ? { renderCall: () => new Text("downstream", 0, 0) } : next();
  let expanded = false;
  const widgets = new Map<string, unknown>();
  const ctx = {
    mode, hasUI: true, cwd: process.cwd(),
    ui: {
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
    registerShortcut: (key: string, value: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, value),
    getSettings: () => ({ terminal: { imageWidthCells: 60 } }),
  } as unknown as ExtensionAPI);
  resolvers.push(downstream);
  const resolve = (name: string, base: () => ToolRenderers | undefined, index = 0): ToolRenderers | undefined =>
    index < resolvers.length ? resolvers[index]!(name, () => resolve(name, base, index + 1)) : base();
  const emit = async (event: ExtensionEvent) => { await handlers.get(event.type)?.(event, ctx); };
  return {
    tui, ctx, emit, widgets,
    start: () => emit({ type: "session_start", reason: "startup" }),
    toggle: () => shortcuts.get("alt+o")?.handler(ctx),
    row: (name: string, id: string, args = {}, definition?: ToolRenderers) =>
      new ToolExecutionComponent(name, id, args, {}, resolve(name, () => definition), tui, ctx.cwd),
  };
}

let timestamp = 0;
const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: {} });
function assistant(content: unknown[]) {
  return { role: "assistant", content, timestamp: ++timestamp } as Extract<ExtensionEvent, {type: "message_start"}>["message"];
}
const plain = (lines: readonly string[]) => lines.map(line => line.replace(/[[0-9;]*m/g, "").trimEnd());

describe("tool groups through the extension entry", () => {
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
      ["stateful", stateful], ["self", { ...stateful, renderShell: "self" }],
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
