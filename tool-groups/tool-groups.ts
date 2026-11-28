import {
  ToolExecutionComponent, sessionEntryToContextMessages, getSelectListTheme,
  type ExtensionAPI, type ExtensionContext, type MessageStartEvent, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";

type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Call = { id: string; name: string };
type Outcome = "running" | "succeeded" | "failed";
type NestedCall = Call & { outcome: Outcome };
type NestedState = { calls: Map<string, NestedCall>; complete?: boolean };
type Group = { calls: Call[]; open: boolean };

export default function toolGroups(pi: ExtensionAPI) {
  let tui: TUI | undefined;
  let sessionContext: ExtensionContext | undefined;
  let globalExpanded = false;
  const groups: Group[] = [];
  const membership = new Map<string, Group>();
  const outcomes = new Map<string, Outcome>();
  const nestedStates = new Map<string, NestedState>();
  const nestedOwners = new Map<string, string>();
  const liveOutcomes = new Map<string, Outcome>();
  let entryIds: string[] = [];
  let historyVersion = 0;
  type Message = MessageStartEvent["message"];
  const messages: Message[] = [];
  let assistantIndex = -1;

  function syncGlobal() {
    const expanded = sessionContext?.ui.getToolsExpanded() ?? false;
    if (expanded === globalExpanded) return;
    globalExpanded = expanded;
    for (const group of groups) group.open = expanded;
  }

  function messageKey(message: Message) {
    return message.role === "toolResult"
      ? `${message.role}:${message.timestamp}:${message.toolCallId}` : JSON.stringify(message);
  }

  function refreshHistory() {
    messages.length = 0;
    assistantIndex = -1;
    liveOutcomes.clear();
    nestedStates.clear();
    nestedOwners.clear();
    entryIds = [];
    historyVersion++;
    rebuild();
  }

  function rebuild() {
    if (!sessionContext) return;
    const entries = sessionContext.sessionManager.buildContextEntries();
    if (entryIds.some((id, index) => entries[index]?.id !== id)) {
      messages.length = 0;
      assistantIndex = -1;
      liveOutcomes.clear();
      nestedStates.clear();
      nestedOwners.clear();
      historyVersion++;
    }
    entryIds = entries.map(entry => entry.id);
    const history = entries.flatMap(sessionEntryToContextMessages);
    const persisted = new Set(history.map(messageKey));
    const active = messages[assistantIndex];
    for (let index = messages.length - 1; index >= 0; index--) {
      if (persisted.has(messageKey(messages[index]!))) messages.splice(index, 1);
    }
    assistantIndex = active ? messages.indexOf(active) : -1;
    syncGlobal();
    outcomes.clear();
    const previous = new Map(groups.map(group => [group.calls[0]!.id, group]));
    groups.length = 0;
    membership.clear();
    let group: Group | undefined;
    for (const message of [...history, ...messages]) {
      if (message.role === "toolResult") recordToolResult(message);
      if (message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error")) {
        for (const block of message.content) {
          if (block.type === "toolCall" && !outcomes.has(block.id)) outcomes.set(block.id, "failed");
        }
      }
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
    for (const [id, outcome] of liveOutcomes) outcomes.set(id, outcome);
    tui?.requestRender();
  }

  pi.on("session_start", (_event, ctx) => {
    groups.length = 0;
    membership.clear();
    outcomes.clear();
    nestedStates.clear();
    nestedOwners.clear();
    messages.length = 0;
    assistantIndex = -1;
    tui = undefined;
    sessionContext = ctx;
    globalExpanded = ctx.ui.getToolsExpanded();
    refreshHistory();
    if (ctx.mode !== "tui") return;
    // The public widget factory supplies the host TUI without replacing the editor.
    ctx.ui.setWidget("tool-groups:acquire", (ui) => {
      tui = ui;
      return new Container();
    });
    ctx.ui.setWidget("tool-groups:acquire", undefined);
  });
  function recordToolResult(message: Extract<MessageStartEvent["message"], { role: "toolResult" }>) {
    outcomes.set(message.toolCallId, message.isError ? "failed" : "succeeded");
    const parent = membership.get(message.toolCallId)?.calls.find(call => call.id === message.toolCallId);
    if (parent?.name !== "codemode" || !message.nestedCalls) return;
    const nested = nestedStates.get(parent.id) ?? { calls: new Map<string, NestedCall>() };
    nested.complete = message.nestedCalls.complete;
    for (const call of message.nestedCalls.calls) {
      const previous = nested.calls.get(call.id);
      // Replayed snapshots must not downgrade completed live outcomes.
      if (!previous || previous.outcome === "running") {
        nested.calls.set(call.id, {
          id: call.id, name: call.name,
          outcome: call.status === "ok" ? "succeeded" : call.status === "error" ? "failed" : "running",
        });
      }
      nestedOwners.set(call.id, parent.id);
    }
    nestedStates.set(parent.id, nested);
  }

  pi.on("session_tree", () => refreshHistory());
  pi.on("session_compact", () => refreshHistory());
  pi.registerCommand("tool-groups", {
    description: "Toggle a historical tool group",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      rebuild();
      if (groups.length === 0) return;
      const version = historyVersion;
      const snapshot = groups.slice().reverse();
      const selected = await ctx.ui.custom<number | undefined>((ui, _theme, _keys, done) => {
        const list = new SelectList(snapshot.map((group, index) => ({
          value: String(index), label: `${snapshot.length - index}. ${summary(group)}`,
        })), Math.max(1, Math.min(10, ui.terminal.rows - 4)), getSelectListTheme());
        list.onSelect = item => done(Number(item.value));
        list.onCancel = () => done(undefined);
        list.onSelectionChange = () => ui.requestRender();
        return {
          capturesViewportInput: true,
          render: width => [truncateToWidth("Tool groups — ↑↓ select, Enter toggles, Escape cancels", width), ...list.render(width)],
          handleInput: data => list.handleInput(data),
          invalidate: () => list.invalidate(),
        };
      });
      rebuild();
      const group = selected === undefined ? undefined : snapshot[selected];
      if (version !== historyVersion || !group || !groups.includes(group)) return;
      group.open = !group.open;
      tui?.requestRender();
    },
  });
  pi.on("message_start", event => {
    if (event.message.role !== "assistant" && event.message.role !== "user" && event.message.role !== "toolResult") return;
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
      messages[assistantIndex] = event.message;
      rebuild();
    } else if (event.message.role === "toolResult") {
      const index = messages.findIndex(message => messageKey(message) === messageKey(event.message));
      if (index < 0) messages.push(event.message);
      else messages[index] = event.message;
      rebuild();
    }
  });
  function recordNested(event: { parentToolCallId?: string; toolCallId: string; toolName: string }, outcome: Outcome) {
    if (!event.parentToolCallId) return;
    const ownerId = nestedOwners.get(event.parentToolCallId) ?? event.parentToolCallId;
    const parent = membership.get(ownerId)?.calls.find(call => call.id === ownerId);
    if (parent?.name !== "codemode") return;
    const nested = nestedStates.get(ownerId) ?? { calls: new Map<string, NestedCall>() };
    if (outcome !== "running" || !nested.calls.has(event.toolCallId)) {
      nested.calls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, outcome });
    }
    nestedStates.set(ownerId, nested);
    nestedOwners.set(event.toolCallId, ownerId);
    tui?.requestRender();
  }
  pi.on("tool_execution_start", event => recordNested(event, "running"));
  pi.on("tool_execution_update", event => recordNested(event, "running"));
  pi.on("tool_execution_end", event => {
    if (event.parentToolCallId) {
      recordNested(event, event.isError ? "failed" : "succeeded");
      return;
    }
    if (!membership.has(event.toolCallId)) return;
    liveOutcomes.set(event.toolCallId, event.isError ? "failed" : "succeeded");
    rebuild();
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
    let incomplete = false;
    for (const call of group.calls) {
      const nested = call.name === "codemode" ? nestedStates.get(call.id) : undefined;
      incomplete ||= nested?.complete === false;
      if (nested && (nested.calls.size > 0 || nested.complete === false)) {
        for (const child of nested.calls.values()) {
          const byOutcome = counts.get(child.name) ?? new Map<Outcome, number>();
          byOutcome.set(child.outcome, (byOutcome.get(child.outcome) ?? 0) + 1);
          counts.set(child.name, byOutcome);
        }
        continue;
      }
      const byOutcome = counts.get(call.name) ?? new Map<Outcome, number>();
      const outcome = outcomes.get(call.id) ?? "running";
      byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
      counts.set(call.name, byOutcome);
    }
    const body = [...counts].map(([name, values]) =>
      name + ": " + (["running", "succeeded", "failed"] as const)
        .filter(outcome => values.has(outcome))
        .map(outcome => values.get(outcome) + " " + outcome).join(", ")
    ).join(" · ");
    return (group.open ? "▾ " : "▸ ") + (body || "codemode") + (incomplete ? " (incomplete)" : "");
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
