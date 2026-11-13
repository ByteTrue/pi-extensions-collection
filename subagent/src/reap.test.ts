import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { reapSubagentOrphans, SUBAGENT_ORPHAN_DIR } from "./index.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJournal(
  sessionId: string,
  childPid: number,
  ownerPid: number,
  dir = SUBAGENT_ORPHAN_DIR,
  overrides: Record<string, unknown> = {},
): { journal: string; start: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const journal = join(dir, `sub_${sessionId}.journal.json`);
  const start = join(dir, `sub_${sessionId}.start`);
  const startValue = childPid > 0
    ? execFileSync("ps", ["-p", String(childPid), "-o", "lstart="], { encoding: "utf8" }).trim()
    : "";
  writeFileSync(start, startValue);
  writeFileSync(
    journal,
    JSON.stringify({ sessionId, ownerPid, childPid, startPath: start, startedAt: Date.now(), ...overrides }),
  );
  return { journal, start };
}

describe("reapSubagentOrphans", () => {
  it("kills a child whose owner is gone and removes its journal", { timeout: 15_000 }, async () => {
    const sessionId = `sub_reap_${Date.now()}`;
    const child = spawn("/bin/sh", ["-c", `sleep 30 # ${sessionId}`], {
      detached: true,
      stdio: "ignore",
    });
    const childPid = child.pid!;
    const { journal, start } = writeJournal(sessionId, childPid, 999_999);
    try {
      expect(alive(childPid)).toBe(true);
      reapSubagentOrphans();
      await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 8000 });
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(start)).toBe(false);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      rmSync(journal, { force: true });
      rmSync(start, { force: true });
    }
  });

  it("does not kill a reused PID when the recorded start differs but the command session matches", async () => {
    const sessionId = `sub_stale_${Date.now()}`;
    const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000) // --session ${sessionId}`], { detached: true, stdio: "ignore" });
    const childPid = child.pid!;
    const { journal, start } = writeJournal(sessionId, childPid, 999_999);
    writeFileSync(start, "STALE_START_FROM_REUSED_PID");
    try {
      reapSubagentOrphans();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(childPid)).toBe(true);
      expect(existsSync(journal)).toBe(true);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      rmSync(journal, { force: true });
      rmSync(start, { force: true });
    }
  });

  it.each(["journal", "start"] as const)("refuses a symlinked %s state file", async (kind) => {
    const sessionId = `sub_symlink_${kind}_${Date.now()}`;
    const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000) // --session ${sessionId}`], { detached: true, stdio: "ignore" });
    const childPid = child.pid!;
    const paths = writeJournal(sessionId, childPid, 999_999);
    const path = paths[kind];
    const target = `${path}.target`;
    writeFileSync(target, readFileSync(path));
    rmSync(path);
    symlinkSync(target, path);
    try {
      reapSubagentOrphans();
      expect(alive(childPid)).toBe(true);
      expect(existsSync(paths.journal)).toBe(true);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      rmSync(paths.journal, { force: true });
      rmSync(paths.start, { force: true });
      rmSync(target, { force: true });
    }
  });

  it("leaves a child alone while its owner is alive", async () => {
    const sessionId = `sub_live_${Date.now()}`;
    const child = spawn("/bin/sh", ["-c", `sleep 30 # ${sessionId}`], {
      detached: true,
      stdio: "ignore",
    });
    const childPid = child.pid!;
    const { journal, start } = writeJournal(sessionId, childPid, process.pid);
    try {
      reapSubagentOrphans();
      expect(alive(childPid)).toBe(true);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      rmSync(journal, { force: true });
      rmSync(start, { force: true });
    }
  });

  it("does not kill a process when the journal has no session id", async () => {
    const sessionId = `sub_missing_${Date.now()}`;
    const child = spawn("/bin/sh", ["-c", `sleep 30 # ${sessionId}`], { detached: true, stdio: "ignore" });
    const childPid = child.pid!;
    const { journal, start } = writeJournal(sessionId, childPid, 999_999, SUBAGENT_ORPHAN_DIR, { sessionId: undefined });
    try {
      reapSubagentOrphans();
      expect(alive(childPid)).toBe(true);
      expect(existsSync(journal)).toBe(true);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      rmSync(journal, { force: true });
      rmSync(start, { force: true });
    }
  });

  it("does not delete a startPath supplied by an invalid-PID journal", () => {
    const sessionId = `sub_bad_pid_${Date.now()}`;
    const victim = join(SUBAGENT_ORPHAN_DIR, `${sessionId}-victim`);
    const { journal, start } = writeJournal(sessionId, -1, 999_999, SUBAGENT_ORPHAN_DIR, { startPath: victim });
    writeFileSync(victim, "do not delete");
    try {
      reapSubagentOrphans();
      expect(existsSync(victim)).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("do not delete");
    } finally {
      for (const path of [journal, start, victim]) rmSync(path, { force: true });
    }
  });

  it("ignores a hostile startPath even in an otherwise valid journal", async () => {
    const sessionId = `sub_hostile_path_${Date.now()}`;
    const child = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000) // ${sessionId}`], { detached: true, stdio: "ignore" });
    const childPid = child.pid!;
    const victim = join(SUBAGENT_ORPHAN_DIR, `${sessionId}-victim`);
    const { journal, start } = writeJournal(sessionId, childPid, 999_999, SUBAGENT_ORPHAN_DIR, { startPath: victim });
    writeFileSync(victim, "do not delete");
    try {
      reapSubagentOrphans();
      await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 8000 });
      expect(existsSync(victim)).toBe(true);
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(start)).toBe(false);
    } finally {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      for (const path of [journal, start, victim]) rmSync(path, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")("refuses a directory owned by another user", () => {
    const sessionId = `sub_foreign_dir_${Date.now()}`;
    const victim = join(SUBAGENT_ORPHAN_DIR, `${sessionId}-victim`);
    const { journal, start } = writeJournal(sessionId, -1, 999_999, SUBAGENT_ORPHAN_DIR, { startPath: victim });
    writeFileSync(victim, "do not delete");
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(statSync(SUBAGENT_ORPHAN_DIR).uid + 1);
    try {
      reapSubagentOrphans();
      expect(existsSync(victim)).toBe(true);
    } finally {
      getuid.mockRestore();
      for (const path of [journal, start, victim]) rmSync(path, { force: true });
    }
  });

  it.skipIf(process.platform === "win32")("migrates an owned loose directory to private permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-orphan-mode-"));
    try {
      chmodSync(dir, 0o755);
      reapSubagentOrphans(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
