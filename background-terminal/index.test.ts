import { existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: vi.fn((...args: Parameters<typeof actual.createWriteStream>) => actual.createWriteStream(...args)),
  };
});
import * as fs from "node:fs";
import registerBackgroundTerminal, { manager, sweepOrphanLogs, type BackgroundTask } from "./background-terminal.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

interface SentMessage {
  message: { customType?: string; content?: string; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

function harness() {
  const toolNames: string[] = [];
  const commandNames: string[] = [];
  const events: string[] = [];
  const rendererTypes: string[] = [];
  const renderers = new Map<string, MessageRenderer>();
  const sent: SentMessage[] = [];
  let sendFailures = 0;
  const handlers: Record<string, Handler> = {};
  const pi = {
    registerTool(tool: { name: string }) {
      toolNames.push(tool.name);
    },
    registerCommand(name: string) {
      commandNames.push(name);
    },
    registerMessageRenderer(type: string, renderer: MessageRenderer) {
      rendererTypes.push(type);
      renderers.set(type, renderer);
    },
    sendMessage(message: SentMessage["message"], options?: SentMessage["options"]) {
      if (sendFailures > 0) {
        sendFailures--;
        throw new Error("transient send failure");
      }
      sent.push({ message, options });
    },
    on(event: string, handler: Handler) {
      events.push(event);
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;

  registerBackgroundTerminal(pi);
  return { toolNames, commandNames, events, rendererTypes, renderers, sent, handlers, failNextSend: () => { sendFailures++; } };
}

const ctxFor = (sessionId: string, setStatus = vi.fn()) => ({
  sessionManager: { getSessionId: () => sessionId },
  ui: { setStatus },
});

describe("background-terminal extension", () => {
  it("registers the three background tools; no built-in name is shadowed", () => {
    const { toolNames, commandNames, events, rendererTypes } = harness();
    expect(toolNames.sort()).toEqual(["background_kill", "background_run", "background_status"]);
    expect(commandNames).toEqual(["background"]);
    // No tool_call/tool_result subscription: the foreground-timeout hook moved to the
    // separate small-extensions/bash-timeout extension (BYTE-10) — this package's
    // installed source contains no hook code at all.
    expect(events.sort()).toEqual(["agent_settled", "agent_start", "session_shutdown", "session_start", "turn_end"]);
    expect(rendererTypes).toEqual(["background-exit"]);
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("powershell");
  });

  it("collapses completion messages by default and expands them with Pi's expanded state", () => {
    const { renderers } = harness();
    const renderer = renderers.get("background-exit")!;
    const message = { customType: "background-exit", content: "FIRST_LINE\nSECOND_LINE" } as Parameters<MessageRenderer>[0];
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
    const expanded = renderer(message, { ...options, expanded: true }, theme)!.render(120).join("\n");
    expect(expanded).toContain("SECOND_LINE");
  });

  it("wakes the agent on completion with followUp + triggerTurn, which is what replaces polling", async () => {
    const { sent, handlers } = harness();
    const sessionId = "notify-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));

    manager.start('node -e "console.log(\'notify-payload\')"', process.cwd(), sessionId);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });

    expect(sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(sent[0]?.message.customType).toBe("background-exit");
    expect(sent[0]?.message.content).toContain('state="completed"');
    expect(sent[0]?.message.content).toContain("Exit code: 0");
    expect(sent[0]?.message.content).toContain("notify-payload");

    await manager.clearSession(sessionId);
  });

  it("does not deliver another session's completion into this session", async () => {
    const { sent, handlers } = harness();
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor("mine"));

    const foreign = manager.start('node -e "console.log(\'other\')"', process.cwd(), "someone-else");
    // Wait for it to genuinely finish, so "nothing was sent" means filtered, not merely not-yet-done.
    await vi.waitFor(() => expect(manager.get(foreign.id, "someone-else")?.status).toBe("exited"), { timeout: 8000 });

    expect(sent).toEqual([]);
    await manager.clearSession("someone-else");
  });

  it("shows the running count in the footer and hides it again at zero", async () => {
    const { handlers } = harness();
    const sessionId = "status-session";
    const setStatus = vi.fn();
    const ctx = ctxFor(sessionId, setStatus);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);

    const first = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), sessionId);
    const second = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), sessionId);
    expect(setStatus).toHaveBeenLastCalledWith("background-terminal", "bg:2");

    manager.kill(first.id, sessionId);
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("background-terminal", "bg:1"), { timeout: 8000 });

    manager.kill(second.id, sessionId);
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith("background-terminal", undefined), {
      timeout: 8000,
    });
    await manager.clearSession(sessionId);
  });

  it("survives /reload but clears tasks and their output files on a real session end", async () => {
    const { handlers } = harness();
    const sessionId = "reload-test-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);

    const task = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), sessionId);

    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);
    expect(manager.get(task.id, sessionId)?.status).toBe("running");
    expect(existsSync(task.outputPath)).toBe(true);

    await handlers.session_start?.({ type: "session_start", reason: "reload" }, ctx);
    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);

    expect(manager.get(task.id, sessionId)).toBeNull();
    await vi.waitFor(() => expect(existsSync(task.outputPath)).toBe(false), { timeout: 8000 });
  });

  // Wait long enough for the exit callback chain (stream close -> onExit) to run after the
  // task status flips to "exited", so "nothing was sent" means buffered, not merely late.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  it("coalesces completions while the agent is busy into a single wake-up message", async () => {
    const { sent, handlers } = harness();
    const sessionId = "batch-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);

    const first = manager.start('node -e "console.log(\'batch-one\')"', process.cwd(), sessionId);
    const second = manager.start('node -e "console.log(\'batch-two\')"', process.cwd(), sessionId);
    await vi.waitFor(() => {
      expect(manager.get(first.id, sessionId)?.status).toBe("exited");
      expect(manager.get(second.id, sessionId)?.status).toBe("exited");
    }, { timeout: 8000 });
    await settle();
    expect(sent).toEqual([]);

    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(sent[0]?.message.customType).toBe("background-exit");
    expect(sent[0]?.message.content).toContain("2 background tasks finished");
    expect(sent[0]?.message.content).toContain("batch-one");
    expect(sent[0]?.message.content).toContain("batch-two");
    expect(Array.isArray(sent[0]?.message.details)).toBe(true);

    await manager.clearSession(sessionId);
  });

  it("keeps the single-task message shape when only one task completes while busy", async () => {
    const { sent, handlers } = harness();
    const sessionId = "solo-batch-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);

    const task = manager.start('node -e "console.log(\'solo\')"', process.cwd(), sessionId);
    await vi.waitFor(() => expect(manager.get(task.id, sessionId)?.status).toBe("exited"), { timeout: 8000 });
    await settle();
    expect(sent).toEqual([]);

    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toContain('state="completed"');
    expect(sent[0]?.message.content).toContain("Exit code: 0");
    expect(sent[0]?.message.content).not.toContain("background tasks finished");
    expect(Array.isArray(sent[0]?.message.details)).toBe(false);

    await manager.clearSession(sessionId);
  });

  it("flushes buffered completions before a reload returns", async () => {
    const { sent, handlers } = harness();
    const sessionId = "reload-completion-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);

    const task = manager.start('node -e "console.log(\'reload-completion\')"', process.cwd(), sessionId);
    await vi.waitFor(() => expect(manager.get(task.id, sessionId)?.status).toBe("exited"), { timeout: 8000 });
    await settle();
    expect(sent).toEqual([]);

    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toContain("reload-completion");
    await manager.clearSession(sessionId);
  });

  it("requeues a completion that lands between reload shutdown and the new session_start", async () => {
    const oldRuntime = harness();
    const sessionId = "reload-handoff-session";
    const ctx = ctxFor(sessionId);
    await oldRuntime.handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await oldRuntime.handlers.agent_start?.({ type: "agent_start" }, ctx);
    let finish!: (result: { exitCode: number }) => void;
    const completion = new Promise<{ exitCode: number }>((resolve) => { finish = resolve; });
    const task = manager.start('node -e ""', process.cwd(), sessionId, {
      operations: { exec: () => completion },
    });

    await oldRuntime.handlers.session_shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);
    finish({ exitCode: 0 });
    await vi.waitFor(() => expect(manager.get(task.id, sessionId)?.status).toBe("exited"));
    await settle();
    expect(oldRuntime.sent).toEqual([]);

    const newRuntime = harness();
    await newRuntime.handlers.session_start?.({ type: "session_start", reason: "reload" }, ctx);

    expect(newRuntime.sent).toHaveLength(1);
    expect(newRuntime.sent[0]?.message.content).toContain(task.id);
    await manager.clearSession(sessionId);
  });

  it("starts cleanly over a legacy manager that predates notification replay", async () => {
    const key = Symbol.for("@bytetrue/pi-background-terminal.manager");
    const store = globalThis as unknown as Record<symbol, unknown>;
    const previous = store[key];
    const pendingKey = Symbol.for("@bytetrue/pi-background-terminal.pending-exits");
    const previousPending = store[pendingKey];
    delete store[pendingKey];
    const legacyTask = (id: string, tail: string): BackgroundTask => ({
      id,
      command: "legacy",
      cwd: process.cwd(),
      parentSessionId: "legacy-manager-session",
      status: "exited",
      exitCode: 0,
      createdAt: new Date(),
      outputPath: join(tmpdir(), "background-terminal", `${id}.log`),
      lineCount: 0,
      tail,
    });
    let legacyOnExit: ((task: BackgroundTask) => void) | undefined;
    const legacy = {
      listAll: () => [legacyTask("bg_fedcba9876543210", "LEGACY_PENDING_BEFORE_INIT")],
      list: () => [],
      init: vi.fn((onExit: typeof legacyOnExit) => { legacyOnExit = onExit; }),
    };
    store[key] = legacy;
    vi.resetModules();
    try {
      const { default: register } = await import("./background-terminal.js");
      const handlers: Record<string, Handler> = {};
      const sendMessage = vi.fn();
      register({
        registerTool: vi.fn(),
        registerCommand: vi.fn(),
        registerMessageRenderer: vi.fn(),
        sendMessage,
        on: (event: string, handler: Handler) => { handlers[event] = handler; },
      } as unknown as ExtensionAPI);

      legacyOnExit?.(legacyTask("bg_0123456789abcdef", "LEGACY_RESULT"));
      await expect(handlers.session_start?.(
        { type: "session_start", reason: "reload" },
        ctxFor("legacy-manager-session"),
      )).resolves.toBeUndefined();
      expect(legacy.init).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage.mock.calls[0]?.[0].content).toContain("LEGACY_RESULT");
      expect(sendMessage.mock.calls[0]?.[0].content).toContain("LEGACY_PENDING_BEFORE_INIT");
    } finally {
      store[key] = previous;
      if (previousPending === undefined) delete store[pendingKey];
      else store[pendingKey] = previousPending;
      vi.resetModules();
    }
  });

  it("retries a completion on the next boundary after sendMessage throws", async () => {
    const runtime = harness();
    const sessionId = "send-retry-session";
    const ctx = ctxFor(sessionId);
    await runtime.handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    runtime.failNextSend();
    const task = manager.start('node -e ""', process.cwd(), sessionId, {
      operations: { exec: async () => ({ exitCode: 0 }) },
    });
    await vi.waitFor(() => expect(manager.get(task.id, sessionId)?.status).toBe("exited"));
    await settle();
    expect(runtime.sent).toHaveLength(0);

    await runtime.handlers.turn_end?.({ type: "turn_end" }, ctx);

    expect(runtime.sent).toHaveLength(1);
    expect(runtime.sent[0]?.message.content).toContain(task.id);
    await manager.clearSession(sessionId);
  });

  it("reports an output write failure even when the command exits zero", async () => {
    const { sent, handlers } = harness();
    const sessionId = "write-error-notice-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));
    const task = manager.start('node -e "setTimeout(() => {}, 200)"', process.cwd(), sessionId);
    const stream = vi.mocked(fs.createWriteStream).mock.results.at(-1)?.value as ReturnType<typeof fs.createWriteStream>;

    stream.emit("error", new Error("ENOSPC: simulated disk full"));

    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });
    const content = sent[0]?.message.content ?? "";
    expect(content).toContain('state="failed"');
    expect(content).toContain("Error: output file write failed: ENOSPC: simulated disk full");
    expect(content).toContain("Exit code: 0");
    await manager.clearSession(sessionId);
  });

  it("drops buffered notifications when the session really ends", async () => {
    const { sent, handlers } = harness();
    const sessionId = "drop-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);

    const task = manager.start('node -e "console.log(\'drop\')"', process.cwd(), sessionId);
    await vi.waitFor(() => expect(manager.get(task.id, sessionId)?.status).toBe("exited"), { timeout: 8000 });
    await settle();

    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);
    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(sent).toEqual([]);
  });


  it("kills a task with no lifetime when the session ends (no zombie process)", async () => {
    const probe = join(tmpdir(), `bt-shutdown-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const { handlers } = harness();
    const sessionId = "shutdown-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    const task = manager.start(`sleep 5; echo alive > ${JSON.stringify(probe)}`, process.cwd(), sessionId);

    await handlers.session_shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(existsSync(probe)).toBe(false);
    expect(manager.get(task.id, sessionId)).toBeNull();
  });

  it("bounds a completion batch and settled history while preserving running and pending work", async () => {
    const { sent, handlers } = harness();
    const sessionId = "bounded-history-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);
    const operations = {
      exec: async (_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
        options.onData(Buffer.alloc(4500, "x"));
        return { exitCode: 0 };
      },
    };
    const running = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), sessionId);
    const finished = Array.from({ length: 101 }, () => manager.start('node -e ""', process.cwd(), sessionId, { operations }));

    await vi.waitFor(() => {
      expect(manager.list(sessionId).filter((task) => task.status !== "running")).toHaveLength(101);
    }, { timeout: 8000 });
    await settle();
    expect(manager.get(finished[0]!.id, sessionId)).not.toBeNull();

    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content?.length).toBeLessThanOrEqual(50_000);
    expect(sent[0]?.message.details).toBeDefined();
    expect(JSON.stringify(sent[0]?.message.details)).not.toContain("xxxx");
    expect(manager.list(sessionId)).toHaveLength(101);
    expect(manager.get(running.id, sessionId)?.status).toBe("running");
    const evicted = finished.find((task) => manager.get(task.id, sessionId) === null);
    expect(evicted).toBeDefined();
    await settle();
    expect(readFileSync(evicted!.outputPath, "utf8")).toContain("x");
    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    utimesSync(evicted!.outputPath, old / 1000, old / 1000);
    sweepOrphanLogs();
    expect(readFileSync(evicted!.outputPath, "utf8")).toContain("x");
    await manager.clearSession(sessionId);
    expect(existsSync(evicted!.outputPath)).toBe(false);
  });

  it("keeps the most recently settled tasks rather than the most recently started", async () => {
    const { handlers } = harness();
    const sessionId = "settled-order-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);
    let finishLong!: (result: { exitCode: number }) => void;
    const longCompletion = new Promise<{ exitCode: number }>((resolve) => { finishLong = resolve; });
    const long = manager.start('node -e "long"', process.cwd(), sessionId, { operations: { exec: () => longCompletion } });
    const operations = { exec: async () => ({ exitCode: 0 }) };
    const shorts = Array.from({ length: 100 }, () => manager.start('node -e "short"', process.cwd(), sessionId, { operations }));
    await vi.waitFor(() => expect(manager.list(sessionId).filter((task) => task.status !== "running")).toHaveLength(100));
    finishLong({ exitCode: 0 });
    await vi.waitFor(() => expect(manager.get(long.id, sessionId)?.status).toBe("exited"));
    await settle();

    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(manager.get(long.id, sessionId)).not.toBeNull();
    expect(manager.list(sessionId)).toHaveLength(100);
    expect(shorts.some((task) => manager.get(task.id, sessionId) === null)).toBe(true);
    await manager.clearSession(sessionId);
  });

  it("chunks an oversized summary without dropping task ids or paths", async () => {
    const { sent, handlers } = harness();
    const sessionId = "summary-chunks-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);
    const operations = { exec: async () => ({ exitCode: 0 }) };
    const finished = Array.from({ length: 600 }, () => manager.start('node -e ""', process.cwd(), sessionId, { operations }));
    await vi.waitFor(() => expect(manager.list(sessionId).filter((task) => task.status !== "running")).toHaveLength(600));
    await settle();

    await handlers.agent_settled?.({ type: "agent_settled" }, ctx);

    expect(sent.length).toBeGreaterThan(1);
    const content = sent.map((notice) => notice.message.content ?? "").join("\n");
    for (const notice of sent) expect(notice.message.content?.length).toBeLessThanOrEqual(50_000);
    for (const task of finished) {
      expect(content).toContain(task.id);
      expect(content).toContain(task.outputPath);
    }
    await manager.clearSession(sessionId);
  });

  it("bounds a summary details error as well as its visible content", async () => {
    const { sent, handlers } = harness();
    const sessionId = "summary-error-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    manager.start('node -e ""', process.cwd(), sessionId, {
      operations: { exec: async () => { throw new Error("E".repeat(100_000)); } },
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const details = sent[0]?.message.details as { error?: string };
    expect(sent[0]?.message.content?.length).toBeLessThanOrEqual(50_000);
    expect(details.error?.length).toBeLessThan(1000);
    await manager.clearSession(sessionId);
  });

  it("wraps the completion notice in a shell tag with a bounded output tail", async () => {
    const { sent, handlers } = harness();
    const sessionId = "notice-format-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));

    manager.start(
      `node -e "for (let i=0;i<200;i++) console.log('line-'+i+'-'+'x'.repeat(30))"`,
      process.cwd(),
      sessionId,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });

    const content = sent[0]?.message.content ?? "";
    expect(content).toMatch(/^<shell id="bg_[0-9a-f]+" state="completed" command="/);
    expect(content).toContain("line-199");
    expect(content).toContain("[earlier output omitted]");
    expect(content).toContain("Exit code: 0");
    expect(content).toContain("</shell>");

    await manager.clearSession(sessionId);
  });


  it("flushes a completion at turn_end while the agent is still busy", async () => {
    const { sent, handlers } = harness();
    const sessionId = "turn-end-session";
    const ctx = ctxFor(sessionId);
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctx);
    await handlers.agent_start?.({ type: "agent_start" }, ctx);

    manager.start('node -e "console.log(\'turn-end\')"', process.cwd(), sessionId);
    await vi.waitFor(() => {
      const task = manager.list(sessionId)[0];
      expect(task?.status).toBe("exited");
    }, { timeout: 8000 });
    await settle();
    expect(sent).toEqual([]);

    await handlers.turn_end?.({ type: "turn_end" }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message.content).toContain("turn-end");

    await manager.clearSession(sessionId);
  });

  it("does not leak ANSI or drop the first line without a truncation marker", async () => {
    const { sent, handlers } = harness();
    const sessionId = "tail-format-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));

    manager.start(
      `node -e "let o=[...Array(51)].map((_,i)=>'row'+i).join('\\n'); process.stdout.write('\\x1b[31m'+o+'\\x1b[0m')"`,
      process.cwd(),
      sessionId,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });

    const content = sent[0]?.message.content ?? "";
    expect(content).toContain("row50");
    expect(content).toContain("[earlier output omitted]");
    expect(content).not.toContain("row0");
    expect(content).not.toContain("\u001b");

    await manager.clearSession(sessionId);
  });


  it("reports a non-zero exit code and a timed-out lifetime in the notice", async () => {
    const { sent, handlers } = harness();
    const sessionId = "notice-status-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));

    manager.start('node -e "process.exit(3)"', process.cwd(), sessionId);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });
    expect(sent[0]?.message.content).toContain("Exit code: 3");

    sent.length = 0;
    manager.start("sleep 30", process.cwd(), sessionId, { timeoutSeconds: 1 });
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });
    const content = sent[0]?.message.content ?? "";
    expect(content).toContain('state="timed_out"');
    expect(content).toContain("Timed out after 1 seconds");
    expect(content).toContain("Do not start another copy");

    await manager.clearSession(sessionId);
  });

  it("sends a killed notice when background_kill stops a task", async () => {
    const { sent, handlers } = harness();
    const sessionId = "killed-notice-session";
    await handlers.session_start?.({ type: "session_start", reason: "startup" }, ctxFor(sessionId));

    const task = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), sessionId);
    expect(manager.kill(task.id, sessionId)).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 8000 });

    const content = sent[0]?.message.content ?? "";
    expect(sent[0]?.message.customType).toBe("background-exit");
    expect(content).toContain('state="killed"');
    expect(content).toContain("The task was stopped.");
    expect(content).toContain("</shell>");

    await manager.clearSession(sessionId);
  });
});
