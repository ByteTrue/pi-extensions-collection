import {
  ToolExecutionComponent,
  type ExtensionAPI, type ExtensionContext, type MessageStartEvent, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Call = { id: string; name: string };
type Outcome = "running" | "succeeded" | "failed";
type Group = { calls: Call[]; open: boolean };

export default function toolGroups(pi: ExtensionAPI) {
  let tui: TUI | undefined;
  let sessionContext: ExtensionContext | undefined;
  let globalExpanded = false;
  const groups: Group[] = [];
  const membership = new Map<string, Group>();
  const outcomes = new Map<string, Outcome>();
  const messages: MessageStartEvent["message"][] = [];
  let assistantIndex = -1;

  function syncGlobal() {
    const expanded = sessionContext?.ui.getToolsExpanded() ?? false;
    if (expanded === globalExpanded) return;
    globalExpanded = expanded;
    for (const group of groups) group.open = expanded;
  }

  function rebuild() {
    syncGlobal();
    const previous = new Map(groups.map(group => [group.calls[0]!.id, group]));
    groups.length = 0;
    membership.clear();
    let group: Group | undefined;
    for (const message of messages) {
      if (message.role === "user") { group = undefined; continue; }
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type !== "toolCall") { group = undefined; continue; }
        if (!group) {
          group = previous.get(block.id) ?? { calls: [], open: globalExpanded };
          group.calls = [];
          groups.push(group);
        }
        group.calls.push({ id: block.id, name: block.name });
        membership.set(block.id, group);
      }
    }
    tui?.requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    groups.length = 0;
    membership.clear();
    outcomes.clear();
    messages.length = 0;
    assistantIndex = -1;
    tui = undefined;
    sessionContext = ctx;
    globalExpanded = ctx.ui.getToolsExpanded();
    if (ctx.mode !== "tui") return;
    // The public widget factory supplies the host TUI without replacing the editor.
    ctx.ui.setWidget("tool-groups:acquire", (ui) => {
      tui = ui;
      return new Container();
    });
    ctx.ui.setWidget("tool-groups:acquire", undefined);
  });
  pi.on("message_start", event => {
    if (event.message.role !== "assistant" && event.message.role !== "user") return;
    messages.push(event.message);
    if (event.message.role === "assistant") assistantIndex = messages.length - 1;
    rebuild();
  });
  pi.on("message_update", event => {
    if (event.message.role !== "assistant" || assistantIndex < 0) return;
    messages[assistantIndex] = event.message;
    rebuild();
  });
  pi.on("message_end", event => {
    if (event.message.role === "assistant" && assistantIndex >= 0) {
      if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
        for (const block of event.message.content) {
          if (block.type === "toolCall" && !outcomes.has(block.id)) outcomes.set(block.id, "failed");
        }
      }
      messages[assistantIndex] = event.message;
      rebuild();
    } else if (event.message.role === "toolResult") {
      outcomes.set(event.message.toolCallId, event.message.isError ? "failed" : "succeeded");
      tui?.requestRender();
    }
  });
  pi.on("tool_execution_end", event => {
    if (event.parentToolCallId) return;
    outcomes.set(event.toolCallId, event.isError ? "failed" : "succeeded");
    tui?.requestRender();
  });
  pi.registerShortcut("alt+o", {
    description: "Toggle the latest tool group",
    handler: () => {
      syncGlobal();
      const group = groups.at(-1);
      if (group) group.open = !group.open;
      tui?.requestRender();
    },
  });

  function summary(group: Group) {
    const counts = new Map<string, Map<Outcome, number>>();
    for (const call of group.calls) {
      const byOutcome = counts.get(call.name) ?? new Map<Outcome, number>();
      const outcome = outcomes.get(call.id) ?? "running";
      byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
      counts.set(call.name, byOutcome);
    }
    return (group.open ? "▾ " : "▸ ") + [...counts].map(([name, values]) =>
      name + ": " + (["running", "succeeded", "failed"] as const)
        .filter(outcome => values.has(outcome))
        .map(outcome => values.get(outcome) + " " + outcome).join(", ")
    ).join(" · ");
  }

  pi.registerToolRenderer((name, next) => {
    const original = next();
    if (!tui) return original;
    const ui = tui;
    const rows = new WeakMap<object, { inner: ToolExecutionComponent; body: Component; context: ToolRenderContext }>();
    function row(context: ToolRenderContext) {
      syncGlobal();
      let row = rows.get(context.state);
      if (!row) {
        const inner = new ToolExecutionComponent(name, context.toolCallId, context.args,
          { outputPad: context.outputPad, showImages: context.showImages, imageWidthCells: pi.getSettings().terminal?.imageWidthCells }, original, ui, context.cwd);
        let nativeHeight = 0;
        const body: Component = {
          render(width) {
            syncGlobal();
            const group = membership.get(context.toolCallId);
            const header = group?.calls[0]?.id === context.toolCallId
              ? [truncateToWidth(summary(group), width)] : [];
            if (group && !group.open) return header;
            const lines = inner.render(width);
            nativeHeight = lines.length;
            return [...header, ...lines.slice(1)];
          },
          handleMouse(event) {
            const group = membership.get(context.toolCallId);
            const header = group?.calls[0]?.id === context.toolCallId;
            if (header && event.y === 0) {
              if (event.type !== "click" || event.button !== "left") return undefined;
              if (ui.mode === "fullscreen") {
                group.open = !group.open;
                ui.requestRender();
              }
              return { handled: true };
            }
            if (group && !group.open) return undefined;
            return inner.handleMouse({ ...event, y: event.y + (header ? 0 : 1), height: nativeHeight });
          },
          invalidate: () => inner.invalidate(),
        };
        row = { inner, body, context };
        rows.set(context.state, row);
      }
      const previous = row.context;
      if (context.executionStarted && !previous.executionStarted) row.inner.markExecutionStarted();
      if (context.argsComplete && !previous.argsComplete) row.inner.setArgsComplete();
      if (context.expanded !== previous.expanded) row.inner.setExpanded(context.expanded);
      if (context.outputPad !== previous.outputPad) row.inner.setOutputPad(context.outputPad);
      if (context.showImages !== previous.showImages) row.inner.setShowImages(context.showImages);
      row.context = context;
      return row;
    }
    return {
      renderShell: "self",
      renderCall: (_args, _theme, context) => {
        const current = row(context);
        current.inner.updateArgs(context.args);
        return current.body;
      },
      renderResult: (result, options, _theme, context) => {
        row(context).inner.updateResult({ ...result, isError: context.isError, durationMs: context.durationMs }, options.isPartial);
        return new Container();
      },
    };
  });
}
