import { afterEach, describe, expect, it, vi } from "vitest";
import { manager, registerBackgroundKillTool } from "./background-terminal.js";
import { call, registerOne } from "./test-helpers.js";

const SESSION_ID = "background-kill-test-session";
const OTHER_SESSION = "background-kill-other-session";

describe("background_kill tool", () => {
  afterEach(async () => {
    await manager.clearSession(SESSION_ID);
    await manager.clearSession(OTHER_SESSION);
  });

  it("stops a running background task", async () => {
    manager.init(() => {});
    const started = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), SESSION_ID);

    const result = await call(registerOne(registerBackgroundKillTool), { id: started.id }, SESSION_ID);

    expect(result.content[0]?.text).toContain("Stopped");
    expect(manager.get(started.id, SESSION_ID)?.status).toBe("killed");
  });


  it("rejects an unconfirmed stop instead of reporting success", async () => {
    let finish!: (error: Error) => void;
    const completion = new Promise<{ exitCode: number }>((_resolve, reject) => { finish = reject; });
    const exec = vi.fn(() => completion);
    const started = manager.start("stalled command", process.cwd(), SESSION_ID, { operations: { exec } });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledOnce(), { timeout: 8000 });
    vi.useFakeTimers();
    try {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      void call(registerOne(registerBackgroundKillTool), { id: started.id }, SESSION_ID).then(onSuccess, onError);
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(new Error("Background command termination could not be confirmed."));
      expect(manager.get(started.id, SESSION_ID)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
      finish(new Error("aborted"));
    }
  });

  it("sends a completion notice when a task is stopped", async () => {
    const exits: string[] = [];
    manager.init((task) => exits.push(task.id));
    const started = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), SESSION_ID);

    const result = await call(registerOne(registerBackgroundKillTool), { id: started.id }, SESSION_ID);
    expect(result.content[0]?.text).toContain("Stopped");

    await vi.waitFor(() => expect(exits).toEqual([started.id]), { timeout: 8000 });
    expect(manager.get(started.id, SESSION_ID)?.status).toBe("killed");
    manager.init(() => {});
  });
  it("reports an already-finished task without erroring", async () => {
    manager.init(() => {});
    const started = manager.start('node -e ""', process.cwd(), SESSION_ID);
    await vi.waitFor(() => expect(manager.get(started.id, SESSION_ID)?.status).toBe("exited"), { timeout: 8000 });

    const result = await call(registerOne(registerBackgroundKillTool), { id: started.id }, SESSION_ID);

    expect(result.content[0]?.text).toContain("already exited");
  });

  it("cannot stop another session's task", async () => {
    manager.init(() => {});
    const started = manager.start('node -e "setInterval(() => {}, 1000)"', process.cwd(), OTHER_SESSION);

    await expect(call(registerOne(registerBackgroundKillTool), { id: started.id }, SESSION_ID)).rejects.toThrow(
      /No background task found/,
    );
    expect(manager.get(started.id, OTHER_SESSION)?.status).toBe("running");
  });

  it("throws for an unknown task id", async () => {
    await expect(call(registerOne(registerBackgroundKillTool), { id: "bg_nope" }, SESSION_ID)).rejects.toThrow(
      /No background task found/,
    );
  });
});
