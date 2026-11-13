import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import registerSubagent, { SubagentTaskManager, subagentManager, type SubagentTaskRecord } from "./index.js";

type Handler = (event?: unknown, ctx?: unknown) => unknown;

function harness() {
  const sent: Array<{ customType?: string; content: string; details?: unknown }> = [];
  let sendFailures = 0;
  let sendCalls = 0;
  let failOnCall = 0;
  const handlers = new Map<string, Handler>();
  const renderers = new Map<string, MessageRenderer>();
  const previousChild = process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_SUBAGENT_CHILD;
  try {
    registerSubagent({
      sendMessage: (message: { customType?: string; content: string; details?: unknown }) => {
        sendCalls++;
        if (sendCalls === failOnCall) throw new Error("transient shard failure");
        if (sendFailures > 0) {
          sendFailures--;
          throw new Error("transient send failure");
        }
        sent.push(message);
      },
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerMessageRenderer: (type: string, renderer: MessageRenderer) => renderers.set(type, renderer),
    } as Parameters<typeof registerSubagent>[0]);
  } finally {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
  }
  return { sent, handlers, renderers, failNextSend: () => { sendFailures++; }, failSendOnCall: (call: number) => { failOnCall = call; } };
}

const ctxFor = (sessionId: string) => ({
  sessionManager: { getSessionId: () => sessionId },
  ui: { setStatus: () => {} },
});

function task(id: string, parentSessionId: string): SubagentTaskRecord {
  return {
    id,
    sessionId: id,
    cwd: "/tmp",
    parentSessionId,
    description: id,
    status: "running",
    output: "",
    startedAt: Date.now(),
    controller: new AbortController(),
    notifyOnExit: true,
  };
}

describe("subagent completion delivery", () => {
  it("collapses completion messages by default and expands them with Pi's expanded state", () => {
    const { renderers } = harness();
    const renderer = renderers.get("subagent-exit")!;
    const message = { customType: "subagent-exit", content: "FIRST_LINE\nSECOND_LINE" } as Parameters<MessageRenderer>[0];
    const options = { expanded: false, outputPad: 1, keyText: () => "Ctrl+O", keyHint: () => "Ctrl+O" } as Parameters<MessageRenderer>[1];
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Parameters<MessageRenderer>[2];

    const collapsed = renderer(message, { ...options, expanded: false }, theme)!.render(120).join("\n");
    expect(collapsed).toContain("FIRST_LINE");
    expect(collapsed).toContain("Ctrl+O");
    expect(collapsed).not.toContain("SECOND_LINE");
    const structured = {
      customType: "subagent-exit",
      content: "<subagent sessionID=\"sub_test\">\nSECOND_LINE",
      details: { id: "sub_test", status: "succeeded", description: "Review patch" },
    } as Parameters<MessageRenderer>[0];
    const concise = renderer(structured, options, theme)!.render(120).join("\n");
    expect(concise).toContain("sub_test completed — Review patch");
    expect(concise).not.toContain("<subagent");
    const expanded = renderer(message, { ...options, expanded: true }, theme)!.render(120).join("\n");
    expect(expanded).toContain("SECOND_LINE");
  });
  it("requeues a completion that lands between reload shutdown and the new session_start", async () => {
    const sessionId = "subagent-reload-handoff";
    const oldRuntime = harness();
    await oldRuntime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    await oldRuntime.handlers.get("agent_start")?.();
    subagentManager.register(task("sub_reload_handoff", sessionId));
    await oldRuntime.handlers.get("session_shutdown")?.({ reason: "reload" });

    subagentManager.complete("sub_reload_handoff", "finished during handoff", false);
    expect(oldRuntime.sent).toHaveLength(0);

    const newRuntime = harness();
    await newRuntime.handlers.get("session_start")?.({}, ctxFor(sessionId));

    expect(newRuntime.sent).toHaveLength(1);
    expect(newRuntime.sent[0]?.content).toContain("finished during handoff");
    await subagentManager.clearSession(sessionId);
  });

  it("bounds a burst of full completion messages with a summary", async () => {
    const sessionId = "subagent-bounded-batch";
    const runtime = harness();
    await runtime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    await runtime.handlers.get("agent_start")?.();
    for (let index = 0; index < 101; index++) {
      const id = `sub_bounded_${index}`;
      subagentManager.register(task(id, sessionId));
      subagentManager.complete(id, "x".repeat(5000), false);
    }

    await runtime.handlers.get("agent_settled")?.({ aborted: false });

    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.content.length).toBeLessThanOrEqual(50_000);
    expect(runtime.sent[0]?.content).toContain("101 background subagent tasks completed");
    expect(runtime.sent[0]?.details).toBeDefined();
    expect(JSON.stringify(runtime.sent[0]?.details)).not.toContain("xxxx");
    await subagentManager.clearSession(sessionId);
  });

  it("recovers a legacy completion queued before the new session_start", async () => {
    const sessionId = "subagent-legacy-handoff";
    const oldRuntime = harness();
    await oldRuntime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    await oldRuntime.handlers.get("agent_start")?.();
    const before = task("sub_legacy_before_init", sessionId);
    const after = task("sub_legacy_after_init", sessionId);
    subagentManager.register(before);
    subagentManager.register(after);
    await oldRuntime.handlers.get("session_shutdown")?.({ reason: "reload" });
    subagentManager.complete(before.id, "LEGACY_PENDING_BEFORE_INIT", false);
    before.notificationPending = undefined;
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("@bytetrue/pi-subagent.pending-exits")];
    const newRuntime = harness();

    subagentManager.complete(after.id, "LEGACY_RESULT", false);
    after.notificationPending = undefined;
    await newRuntime.handlers.get("session_start")?.({}, ctxFor(sessionId));

    expect(newRuntime.sent).toHaveLength(1);
    expect(newRuntime.sent[0]?.content).toContain("LEGACY_RESULT");
    expect(newRuntime.sent[0]?.content).toContain("LEGACY_PENDING_BEFORE_INIT");
    await subagentManager.clearSession(sessionId);
  });

  it("retries on the next boundary after sendMessage throws", async () => {
    const sessionId = "subagent-send-retry";
    const runtime = harness();
    await runtime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    runtime.failNextSend();
    subagentManager.register(task("sub_send_retry", sessionId));
    subagentManager.complete("sub_send_retry", "retry me", false);
    expect(runtime.sent).toHaveLength(0);

    await runtime.handlers.get("agent_settled")?.({ aborted: false });

    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.content).toContain("retry me");
    await subagentManager.clearSession(sessionId);
  });

  it("chunks oversized summaries and keeps clone-safe BySpace terminal details", async () => {
    const sessionId = "subagent-summary-chunks";
    const runtime = harness();
    await runtime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    await runtime.handlers.get("agent_start")?.();
    const ids = Array.from({ length: 2000 }, (_, index) => `sub_summary_${index}`);
    for (const id of ids) {
      subagentManager.register(task(id, sessionId));
      subagentManager.complete(id, "x".repeat(5000), false);
    }

    runtime.failSendOnCall(2);
    await runtime.handlers.get("agent_settled")?.({ aborted: false });
    expect(runtime.sent).toHaveLength(1);
    await runtime.handlers.get("agent_settled")?.({ aborted: false });

    expect(runtime.sent.length).toBeGreaterThan(1);
    const content = runtime.sent.map((notice) => notice.content).join("\n");
    const details = runtime.sent.flatMap((notice) => {
      if (Array.isArray(notice.details)) return notice.details as Record<string, unknown>[];
      return [notice.details as Record<string, unknown>];
    });
    for (const notice of runtime.sent) expect(notice.content.length).toBeLessThanOrEqual(50_000);
    for (const id of ids) expect(content).toContain(id);
    expect(details).toHaveLength(ids.length);
    expect(new Set(details.map((detail) => detail.id)).size).toBe(ids.length);
    for (const detail of details) {
      expect(detail.id).toMatch(/^sub_summary_/);
      expect(detail.status).toBe("succeeded");
      expect(detail.sessionId).toBe(detail.id);
      expect(detail.cwd).toBe("/tmp");
      expect(detail.output).toBeUndefined();
      expect(detail.progress).toBeUndefined();
    }
    await subagentManager.clearSession(sessionId);
  });

  it("uses the known child session pointer in a fast-child summary", async () => {
    const sessionId = "subagent-fast-summary";
    const runtime = harness();
    await runtime.handlers.get("session_start")?.({}, ctxFor(sessionId));
    const record = task("sub_fast_child", sessionId);
    record.sessionId = "sub_real_child";
    record.cwd = "/tmp/launch-cwd";
    subagentManager.register(record);
    subagentManager.complete(record.id, "x".repeat(60_000), false);

    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.content).toContain("sub_real_child");
    expect(runtime.sent[0]?.content).toContain("/tmp/launch-cwd");
    expect(runtime.sent[0]?.content).not.toContain("unavailable");
    await subagentManager.clearSession(sessionId);
  });

  it("evicts only delivered finished records beyond the fixed limit", () => {
    const manager = new SubagentTaskManager();
    const session = "history-session";
    const delivered: string[] = [];
    manager.init((record) => delivered.push(record.id), () => {});
    manager.register(task("still-running", session));
    const finished = Array.from({ length: 101 }, (_, index) => task(`finished-${index}`, session));
    for (const record of finished) {
      manager.register(record);
      manager.complete(record.id, "done", false);
    }

    expect(manager.list(session)).toHaveLength(102);
    expect(manager.get(finished[0]!.id)).toBeDefined();
    for (const id of delivered) manager.notificationDelivered(id);

    expect(manager.list(session)).toHaveLength(101);
    expect(manager.get("still-running")?.status).toBe("running");
    expect(manager.get(finished[0]!.id)).toBeUndefined();
    expect(manager.get(finished.at(-1)!.id)).toBeDefined();
  });
});
