import { expect, it, vi } from "vitest";
import { BackgroundManager } from "./background-terminal.js";

it("rejects an unconfirmed stop at the deadline without losing track of the task", async () => {
  const manager = new BackgroundManager();
  const sessionId = "stop-and-wait";
  let signal: AbortSignal | undefined;
  let finish!: (error: Error) => void;
  const completion = new Promise<{ exitCode: number }>((_resolve, reject) => { finish = reject; });
  const task = manager.start("stalled command", process.cwd(), sessionId, {
    operations: { exec: (_command, _cwd, options) => {
      signal = options.signal;
      return completion;
    } },
  });

  vi.useFakeTimers();
  try {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    void manager.stopAndWait(task.id, sessionId).then(onSuccess, onError);

    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onError).toHaveBeenCalledWith(new Error("Background command termination could not be confirmed."));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(manager.get(task.id, sessionId)?.status).toBe("running");
  } finally {
    vi.useRealTimers();
    finish(new Error("aborted"));
    await manager.clearSession(sessionId);
  }
});
