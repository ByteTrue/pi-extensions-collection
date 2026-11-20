import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { manager, reapOrphans } from "./background-terminal.js";

// Other test files run their own reapers; keep simulated owner deaths private.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const isolated = mkdtempSync(join(actual.tmpdir(), "pi-bg-reap-"));
  return { ...actual, tmpdir: () => isolated };
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const SESSION = "reap-test-session";
const DIR = join(tmpdir(), "background-terminal");

afterAll(() => rmSync(tmpdir(), { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("reapOrphans", () => {
  it.each(["", "exec "])("kills a real orphan process tree with prefix %s and removes its journal and log", async (prefix) => {
    const task = manager.start(prefix + 'node -e "console.log(process.pid); setInterval(() => {}, 1000)"', process.cwd(), SESSION);
    const journalPath = join(DIR, task.id + ".journal.json");
    try {
      await vi.waitFor(() => expect(manager.get(task.id, SESSION)?.tail.trim()).toMatch(/^\d+$/), { timeout: 8000 });
      const childPid = Number(manager.get(task.id, SESSION)!.tail.trim());
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pidPath: string; startPath: string };
      const pid = Number(readFileSync(journal.pidPath, "utf8"));
      expect(alive(pid)).toBe(true);
      expect(alive(childPid)).toBe(true);
      expect(readFileSync(journal.startPath, "utf8").trim()).not.toBe("");

      writeFileSync(journalPath, JSON.stringify({ ...journal, ownerPid: 999_999 }));
      await reapOrphans();

      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8000 });
      await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 8000 });
      expect(existsSync(journalPath)).toBe(false);
      expect(existsSync(task.outputPath)).toBe(false);
    } finally {
      await manager.clearSession(SESSION);
    }
  });

  it("records process identity before a long-running shell prefix", async () => {
    const task = manager.start("echo unreachable", process.cwd(), SESSION, {
      commandPrefix: 'node -e "console.log(process.pid); setInterval(() => {}, 1000)"',
    });
    try {
      await vi.waitFor(() => expect(manager.get(task.id, SESSION)?.tail.trim()).toMatch(/^\d+$/), { timeout: 8000 });
      expect(existsSync(join(DIR, task.id + ".pid"))).toBe(true);
      expect(readFileSync(join(DIR, task.id + ".start"), "utf8").trim()).not.toBe("");
    } finally {
      await manager.clearSession(SESSION);
    }
  });

  it.each(["owner", "task"])("retains a task when its %s process probe is denied", async (target) => {
    const task = manager.start("sleep 30", process.cwd(), SESSION);
    const journalPath = join(DIR, task.id + ".journal.json");
    const startPath = join(DIR, task.id + ".start");
    const originalKill = process.kill;
    const kill = vi.spyOn(process, "kill");
    try {
      await vi.waitFor(() => expect(readFileSync(startPath, "utf8").trim()).not.toBe(""), { timeout: 8000 });
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pidPath: string };
      const pid = Number(readFileSync(journal.pidPath, "utf8"));
      writeFileSync(journalPath, JSON.stringify({ ...journal, ownerPid: target === "owner" ? process.pid : 999_999 }));
      kill.mockImplementation((candidate, signal) => {
        if (candidate === (target === "owner" ? process.pid : pid) && signal === 0) {
          throw Object.assign(new Error("EPERM: simulated process probe denial"), { code: "EPERM" });
        }
        if (target === "task" && Math.abs(candidate) === pid && signal !== 0) {
          throw Object.assign(new Error("EPERM: simulated kill denial"), { code: "EPERM" });
        }
        return originalKill(candidate, signal);
      });
      const originalExec = vi.mocked(execFile).getMockImplementation()!;
      vi.mocked(execFile).mockImplementation((file, ...args) => {
        if (target === "task" && /taskkill(?:\.exe)?$/i.test(String(file))) throw new Error("EACCES: simulated kill denial");
        return originalExec(file, ...args);
      });
      try {
        await reapOrphans();
        expect(existsSync(journalPath)).toBe(true);
        expect(existsSync(task.outputPath)).toBe(true);
      } finally {
        vi.mocked(execFile).mockImplementation(originalExec);
      }
    } finally {
      kill.mockRestore();
      await manager.clearSession(SESSION);
    }
  });

  it("retains metadata and output when the process cannot be killed", async () => {
    const task = manager.start("sleep 30", process.cwd(), SESSION);
    const journalPath = join(DIR, task.id + ".journal.json");
    const startPath = join(DIR, task.id + ".start");
    const originalExec = vi.mocked(execFile).getMockImplementation()!;
    const originalKill = process.kill;
    const kill = vi.spyOn(process, "kill");
    try {
      await vi.waitFor(() => expect(readFileSync(startPath, "utf8").trim()).not.toBe(""), { timeout: 8000 });
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { pidPath: string };
      const pid = Number(readFileSync(journal.pidPath, "utf8"));
      writeFileSync(journalPath, JSON.stringify({ ...journal, ownerPid: 999_999 }));
      vi.mocked(execFile).mockImplementation((file, ...args) => {
        if (/taskkill(?:\.exe)?$/i.test(String(file))) throw new Error("EACCES: simulated kill failure");
        return originalExec(file, ...args);
      });
      kill.mockImplementation((target, signal) => {
        if (Math.abs(target) === pid && signal !== 0) throw new Error("EPERM: simulated kill failure");
        return originalKill(target, signal);
      });

      await reapOrphans();

      expect(alive(pid)).toBe(true);
      expect(existsSync(journalPath)).toBe(true);
      expect(existsSync(task.outputPath)).toBe(true);
    } finally {
      kill.mockRestore();
      vi.mocked(execFile).mockImplementation(originalExec);
      await manager.clearSession(SESSION);
    }
  });

  it("keeps a fresh journal while the wrapper has not written its PID yet", async () => {
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

      await reapOrphans();

      expect(existsSync(journalPath)).toBe(true);
      expect(existsSync(outputPath)).toBe(true);

      writeFileSync(journalPath, JSON.stringify({ ...journal, startedAt: Date.now() - 11_000 }));
      await reapOrphans();
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
      await reapOrphans();
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
    writeFileSync(journalPath, JSON.stringify({ taskId: id, ownerPid: 999_999, command: "", outputPath, pidPath, startPath, startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }));
    try {
      await reapOrphans();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid)).toBe(true);
      expect(existsSync(journalPath)).toBe(true);
    } finally {
      try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {}
      for (const path of [journalPath, pidPath, startPath, outputPath]) rmSync(path, { force: true });
    }
  });

  // Creating symlinks needs admin rights or Developer Mode on Windows, so the fixture
  // cannot be built there; the symlink-rejection logic is POSIX-tested.
  it.skipIf(process.platform === "win32").each(["journal", "pid", "start"] as const)("refuses a symlinked %s state file", async (kind) => {
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
      await reapOrphans();
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

    await reapOrphans();
    expect(manager.get(task.id, SESSION)?.status).toBe("running");

    await manager.clearSession(SESSION);
  });
});
