import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("keeps a fresh journal while the wrapper has not written its PID yet", () => {
    const id = "bg_0123456789abcdef";
    const journalPath = join(DIR, `${id}.journal.json`);
    const outputPath = join(DIR, `${id}.log`);
    const journal = {
      taskId: id,
      ownerPid: 999_999,
      command: "sleep 30",
      outputPath,
      pidPath: join(DIR, `${id}.pid`),
      startPath: join(DIR, `${id}.start`),
      startedAt: Date.now(),
    };
    try {
      writeFileSync(outputPath, "");
      writeFileSync(journalPath, JSON.stringify(journal));

      reapOrphans();

      expect(existsSync(journalPath)).toBe(true);
      expect(existsSync(outputPath)).toBe(true);

      writeFileSync(journalPath, JSON.stringify({ ...journal, startedAt: Date.now() - 11_000 }));
      reapOrphans();
      expect(existsSync(journalPath)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      for (const path of [journalPath, outputPath, journal.pidPath, journal.startPath]) rmSync(path, { force: true });
    }
  });

  it.skipIf(process.platform !== "darwin")("stops a macOS orphan process group before killing it", async () => {
    const session = "reap-darwin-order-session";
    const task = manager.start("sleep 30", process.cwd(), session);
    const journalPath = join(DIR, `${task.id}.journal.json`);
    await vi.waitFor(() => expect(existsSync(journalPath)).toBe(true), { timeout: 8000 });
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pidPath: string };
    await vi.waitFor(() => expect(existsSync(journal.pidPath)).toBe(true), { timeout: 8000 });
    const pid = Number(readFileSync(journal.pidPath, "utf8"));
    writeFileSync(journalPath, JSON.stringify({ ...journal, taskId: task.id, ownerPid: 999_999, startedAt: Date.now() }));
    const kill = vi.spyOn(process, "kill");
    try {
      reapOrphans();
      const groupSignals = kill.mock.calls.filter(([target, signal]) => target === -pid && signal !== 0);
      expect(groupSignals[0]).toEqual([-pid, "SIGSTOP"]);
      expect(groupSignals[1]).toEqual([-pid, "SIGKILL"]);
    } finally {
      kill.mockRestore();
      await manager.clearSession(session);
    }
  });

  it("does not kill a reused PID when the recorded start differs but the command marker matches", async () => {
    const id = "bg_0123456789abcdee";
    const journalPath = join(DIR, `${id}.journal.json`);
    const pidPath = join(DIR, `${id}.pid`);
    const startPath = join(DIR, `${id}.start`);
    const outputPath = join(DIR, `${id}.log`);
    const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000) // pi-bg:${id}`], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    writeFileSync(pidPath, String(pid));
    writeFileSync(startPath, "STALE_START_FROM_REUSED_PID");
    writeFileSync(journalPath, JSON.stringify({ taskId: id, ownerPid: 999_999, command: "", outputPath, pidPath, startPath, startedAt: Date.now() }));
    try {
      reapOrphans();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid)).toBe(true);
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      for (const path of [journalPath, pidPath, startPath, outputPath]) rmSync(path, { force: true });
    }
  });

  it.each(["journal", "pid", "start"] as const)("refuses a symlinked %s state file", async (kind) => {
    const session = `reap-symlink-${kind}-session`;
    const task = manager.start("sleep 30", process.cwd(), session);
    const journalPath = join(DIR, `${task.id}.journal.json`);
    await vi.waitFor(() => expect(existsSync(journalPath)).toBe(true), { timeout: 8000 });
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pidPath: string; startPath: string };
    await vi.waitFor(() => expect(existsSync(journal.startPath)).toBe(true), { timeout: 8000 });
    const pid = Number(readFileSync(journal.pidPath, "utf8"));
    writeFileSync(journalPath, JSON.stringify({ ...journal, ownerPid: 999_999 }));
    const path = kind === "journal" ? journalPath : kind === "pid" ? journal.pidPath : journal.startPath;
    const target = `${path}.target`;
    writeFileSync(target, readFileSync(path));
    rmSync(path);
    symlinkSync(target, path);
    try {
      reapOrphans();
      expect(alive(pid)).toBe(true);
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      rmSync(target, { force: true });
      await manager.clearSession(session);
    }
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
