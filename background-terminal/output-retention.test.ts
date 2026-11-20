import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCompletionSource } from "../shared/completion-delivery.js";
import { BackgroundManager, reapOrphans, sweepOrphanLogs } from "./background-terminal.js";

vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const isolated = fs.mkdtempSync(path.join(actual.tmpdir(), "pi-output-retention-"));
  return { ...actual, tmpdir: () => isolated };
});

let profile: string;
let manager: BackgroundManager;
let delivery: ReturnType<typeof registerCompletionSource>;
let task: ReturnType<BackgroundManager["start"]>;
const parent = "retention-parent";

beforeEach(async () => {
  mkdirSync(tmpdir(), { recursive: true });
  profile = mkdtempSync(join(tmpdir(), "profile-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", profile);
  manager = new BackgroundManager();
  delivery = registerCompletionSource("background-terminal", {
    storageDir: join(profile, "completion-notices"), sessionId: () => parent, pending: () => [], send: () => {},
  });
  manager.init((result) => delivery.persist(parent, {
    ids: [result.id], message: { customType: "background-exit", content: result.outputPath, display: true }, delivered: () => {},
  }));
  task = manager.start("fixture", process.cwd(), parent, {
    operations: { exec: async (_command, _cwd, { onData }) => { await onData(Buffer.from("retained output")); return { exitCode: 0 }; } },
  });
  await vi.waitFor(() => expect(readdirSync(join(profile, "completion-notices")).filter((name) => name.endsWith(".json"))).toHaveLength(1));
  await manager.clearSession(parent, true);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(task.outputPath, old, old);
});

afterEach(async () => {
  await manager.clearSession(parent);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(tmpdir(), { recursive: true, force: true });
});

it("retains a pending log across a different profile sweep, then collects it after acknowledgement", () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "another-profile"));
  sweepOrphanLogs();
  expect(readFileSync(task.outputPath, "utf8")).toBe("retained output");
  delivery.flush();
  sweepOrphanLogs();
  expect(existsSync(task.outputPath)).toBe(false);
  expect(existsSync(task.outputPath + ".profile")).toBe(false);
});

it.each(["relative", "x".repeat(32_769)])("keeps a log whose profile marker is invalid (%#)", (marker) => {
  writeFileSync(task.outputPath + ".profile", marker);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  sweepOrphanLogs();
  expect(existsSync(task.outputPath)).toBe(true);
});

it("collects an old profile marker only after its log is gone", () => {
  const marker = task.outputPath + ".profile";
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(marker, old, old);
  sweepOrphanLogs();
  expect(existsSync(marker)).toBe(true);
  rmSync(task.outputPath);
  sweepOrphanLogs();
  expect(existsSync(marker)).toBe(false);
});

it.each([false, true])("retains output during orphan recovery when a settled journal remains (unreadable store: %s)", async (corrupt) => {
  const journal = join(dirname(task.outputPath), task.id + ".journal.json");
  writeFileSync(journal, JSON.stringify({ taskId: task.id, ownerPid: 2_000_000_200, startedAt: Date.now() - 60_000 }), { mode: 0o600 });
  if (corrupt) {
    const notice = readdirSync(join(profile, "completion-notices")).find((name) => name.endsWith(".json"))!;
    writeFileSync(join(profile, "completion-notices", notice), "broken");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpdir(), "another-profile"));
  await reapOrphans();
  expect(existsSync(journal)).toBe(false);
  expect(readFileSync(task.outputPath, "utf8")).toBe("retained output");
});
