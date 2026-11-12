import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

function writeJournal(sessionId: string, childPid: number, ownerPid: number): { journal: string; start: string } {
  mkdirSync(SUBAGENT_ORPHAN_DIR, { recursive: true });
  const journal = join(SUBAGENT_ORPHAN_DIR, `sub_${sessionId}.journal.json`);
  const start = join(SUBAGENT_ORPHAN_DIR, `sub_${sessionId}.start`);
  const startValue = execFileSync("ps", ["-p", String(childPid), "-o", "lstart="], {
    encoding: "utf8",
  }).trim();
  writeFileSync(start, startValue);
  writeFileSync(
    journal,
    JSON.stringify({ sessionId, ownerPid, childPid, startPath: start, startedAt: Date.now() }),
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
});
