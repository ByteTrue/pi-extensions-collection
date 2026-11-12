import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { manager, reapOrphans } from "./background-terminal.js";

const SESSION = "reap-test-session";
const DIR = join(tmpdir(), "background-terminal");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("reapOrphans", () => {
  it("kills a task whose owner Pi is gone and removes its journal and log", async () => {
    const task = manager.start("sleep 30", process.cwd(), SESSION);
    const journalPath = join(DIR, `${task.id}.journal.json`);
    const outputPath = task.outputPath;

    await vi.waitFor(() => expect(existsSync(journalPath)).toBe(true), { timeout: 8000 });
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      ownerPid: number;
      pidPath: string;
      startPath: string;
    };
    await vi.waitFor(() => expect(existsSync(journal.pidPath)).toBe(true), { timeout: 8000 });
    const pid = Number(readFileSync(journal.pidPath, "utf8"));
    expect(pid).toBeGreaterThan(0);

    // Pretend the Pi that started this task was SIGKILLed.
    writeFileSync(journalPath, JSON.stringify({ ...journal, ownerPid: 999_999 }));
    reapOrphans();

    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8000 });
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(outputPath)).toBe(false);

    await manager.clearSession(SESSION);
  });

  it("leaves a task alone while its owner is alive", async () => {
    const task = manager.start("sleep 30", process.cwd(), SESSION);
    const journalPath = join(DIR, `${task.id}.journal.json`);
    await vi.waitFor(() => expect(existsSync(journalPath)).toBe(true), { timeout: 8000 });

    reapOrphans();
    expect(manager.get(task.id, SESSION)?.status).toBe("running");

    await manager.clearSession(SESSION);
  });
});
