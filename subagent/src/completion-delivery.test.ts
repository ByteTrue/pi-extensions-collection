import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCompletionSource, type Completion } from "../../shared/completion-delivery.js";

const state = (globalThis as unknown as Record<symbol, { sources: Map<string, unknown>; timers: Map<string, ReturnType<typeof setTimeout>> }>)[Symbol.for("pi-extensions.completion-delivery")]!;
afterEach(() => {
  for (const timer of state.timers.values()) clearTimeout(timer);
  state.timers.clear();
  state.sources.clear();
  vi.useRealTimers();
});

function source(id: string, sessionId: string, send: Parameters<typeof registerCompletionSource>[1]["send"]) {
  const pending: Completion[] = [];
  const delivery = registerCompletionSource(id, { sessionId: () => sessionId, pending: () => pending.slice(), send });
  const add = (taskId: string) => {
    const completion: Completion = {
      message: { customType: id, content: taskId, display: true, details: { id: taskId } },
      delivered: () => { pending.splice(pending.indexOf(completion), 1); },
    };
    pending.push(completion);
  };
  return { delivery, pending, add };
}

describe("shared completion delivery", () => {
  it("delivers shell and child results with one continuation, preserving their replay data", () => {
    const send = vi.fn();
    const shell = source("background-exit", "parent", send);
    const child = source("subagent-notify", "parent", send);
    const foreign = source("foreign", "other-parent", send);
    shell.add("bg_one");
    child.add("sub_one");
    child.add("sub_two");
    foreign.add("foreign-task");
    shell.delivery.flush();
    child.delivery.flush();
    expect(send.mock.calls.map(([message]) => message.details.id)).toEqual(["bg_one", "sub_one", "sub_two"]);
    expect(send.mock.calls.map(([, options]) => options)).toEqual([
      { deliverAs: "steer", triggerTurn: false },
      { deliverAs: "steer", triggerTurn: false },
      { deliverAs: "steer", triggerTurn: true },
    ]);
    expect(foreign.pending).toHaveLength(1);
  });

  it("coalesces nearby idle completions across sources", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const shell = source("shell", "parent", send);
    const child = source("child", "parent", send);
    shell.add("bg_one");
    shell.delivery.schedule();
    await vi.advanceTimersByTimeAsync(25);
    child.add("sub_one");
    child.delivery.schedule();
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains failed deliveries and retries without replaying accepted cards", () => {
    const send = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("offline"); });
    const shell = source("shell", "parent", send);
    const child = source("child", "parent", send);
    shell.add("bg_one");
    child.add("sub_one");
    shell.delivery.flush();
    expect(shell.pending).toHaveLength(0);
    expect(child.pending).toHaveLength(1);
    child.delivery.flush();
    expect(send.mock.calls.map(([message]) => message.content)).toEqual(["bg_one", "sub_one", "sub_one"]);
    expect(send.mock.calls[2]?.[1].triggerTurn).toBe(true);
    expect(child.pending).toHaveLength(0);
  });

  it("uses the replacement runtime after reload and cancels idle wake-ups on shutdown", async () => {
    vi.useFakeTimers();
    const oldSend = vi.fn();
    const old = source("shell", "parent", oldSend);
    old.add("old");
    old.delivery.schedule();
    const send = vi.fn();
    const fresh = source("shell", "parent", send);
    fresh.add("fresh");
    old.delivery.flush();
    await vi.advanceTimersByTimeAsync(50);
    expect(oldSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    fresh.add("shutdown");
    fresh.delivery.schedule();
    fresh.delivery.cancel();
    fresh.delivery.flush(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[1].triggerTurn).toBe(false);
  });
});
