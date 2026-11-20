import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { reapSubagentOrphans } from "./index.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), readFile: vi.fn(),
}));

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
function mockQuery(query: (command: string, args: string[]) => string | undefined, delay = 0) {
  vi.mocked(execFile).mockImplementation((command, args, _options, callback) => {
    setTimeout(() => {
      const value = query(command, args as string[]);
      (callback as Callback)(value === undefined ? new Error("probe failed") : null, value ?? "", "");
    }, delay);
    return {} as ReturnType<typeof execFile>;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(execFile).mockReset();
  vi.mocked(readFile).mockReset();
});

it.each([
  { label: "unreadable identity", recorded: "child-start", observed: undefined, retained: true },
  { label: "missing recorded identity", recorded: "", observed: "another command", retained: true },
  { label: "confirmed PID reuse", recorded: "original-start", observed: "replacement-start", retained: false },
])("handles an old journal with $label without killing an unverified process", async ({ recorded, observed, retained }) => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-old-reap-"));
  const journal = join(dir, "sub_old.journal.json");
  const start = join(dir, "sub_old.start");
  writeFileSync(start, recorded);
  writeFileSync(journal, JSON.stringify({
    sessionId: "sub_old", ownerPid: 424242, childPid: 424243, startedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
  }));
  const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === 424242) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  mockQuery(() => observed);
  try {
    await reapSubagentOrphans(dir);
    expect(existsSync(journal)).toBe(retained);
    expect(existsSync(start)).toBe(retained);
    expect(kill.mock.calls.every((call) => call[1] === 0)).toBe(true);
    expect(vi.mocked(execFile).mock.calls.some((call) => String(call[0]).includes("taskkill"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retains the journal and start identity when orphan termination fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-failed-reap-"));
  const journal = join(dir, "sub_retry.journal.json");
  const start = join(dir, "sub_retry.start");
  writeFileSync(start, "child-start");
  writeFileSync(journal, JSON.stringify({ sessionId: "sub_retry", ownerPid: 424242, childPid: 424243, startedAt: Date.now() }));
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (signal === 0 && pid === 424242) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    if (signal === 0) return true;
    throw Object.assign(new Error("denied"), { code: "EPERM" });
  });
  mockQuery((command) => command.includes("taskkill") ? undefined : "child-start");
  try {
    await reapSubagentOrphans(dir);
    expect(existsSync(journal)).toBe(true);
    expect(existsSync(start)).toBe(true);
    if (process.platform === "win32") {
      expect(execFile).toHaveBeenCalledWith("taskkill", ["/PID", "424243", "/T", "/F"], expect.anything(), expect.any(Function));
    } else {
      expect(kill).toHaveBeenCalledWith(-424243, "SIGKILL");
      expect(kill).toHaveBeenCalledWith(424243, "SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  "missing recorded identity", "unreadable current identity", "known PID reuse", "same basename elsewhere",
  "path suffix", "script argument", "relative journal path", "wrong session filename", "missing transcript",
  "newline separators", "newline suffix", "NBSP suffix",
])("verifies a resumed transcript with %s", async (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-resume-reap-"));
  const folder = join(dir, "path with spaces");
  mkdirSync(folder);
  const file = join(/newline|NBSP/.test(scenario) ? dir : folder, "time_sub_resumed.jsonl");
  const journal = join(dir, "sub_resume.journal.json");
  writeFileSync(file, "{}\n");
  const sessionFile = scenario === "relative journal path" ? "time_sub_resumed.jsonl"
    : scenario === "wrong session filename" ? join(folder, "time_sub_another.jsonl") : file;
  writeFileSync(journal, JSON.stringify({ sessionId: "sub_resumed", sessionFile, ownerPid: 424242, childPid: 424243, startedAt: Date.now() }));
  writeFileSync(join(dir, "sub_resume.start"), ["unreadable current identity", "known PID reuse"].includes(scenario) ? "recorded" : "");
  if (scenario === "missing transcript") rmSync(file);
  const argument = scenario === "same basename elsewhere" ? join(dir, "elsewhere", "time_sub_resumed.jsonl")
    : scenario === "path suffix" ? file + ".bak" : file;
  const args = scenario === "script argument" ? ["node", "-e", "// --session " + argument] : ["node", "cli.js", "--session", argument];
  vi.mocked(readFile).mockResolvedValue(args.join("\0") + "\0");
  const command = scenario === "newline separators" ? "node cli.js note\n--session\n" + file
    : scenario === "newline suffix" ? "node cli.js --session " + file + "\n"
    : scenario === "NBSP suffix" ? "node cli.js --session " + file + "\u00a0"
    : args.map((arg) => '"' + arg + '"').join(" ");
  if (/newline|NBSP/.test(scenario)) vi.mocked(readFile).mockResolvedValue(["node", "cli.js", command].join("\0") + "\0");
  mockQuery((executable, query) => executable.includes("taskkill") ? ""
    : /CommandLine|command=/.test(query.join(" ")) ? process.platform === "win32" ? JSON.stringify(command) : command
    : scenario === "unreadable current identity" ? undefined : "replacement");
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === 424242 && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
    return true;
  });
  try {
    await reapSubagentOrphans(dir);
    const supported = process.platform === "win32" || process.platform === "linux";
    const terminated = supported && ["missing recorded identity", "unreadable current identity"].includes(scenario);
    expect(existsSync(journal)).toBe(!terminated);
    const signals = kill.mock.calls.some((call) => call[1] !== 0);
    const taskkill = vi.mocked(execFile).mock.calls.some((call) => String(call[0]).includes("taskkill"));
    expect(signals || taskkill).toBe(terminated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("keeps timers responsive and shares an owner probe across records and overlapping scans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-async-reap-"));
  for (const id of ["one", "two"]) {
    writeFileSync(join(dir, "sub_" + id + ".journal.json"), JSON.stringify({
      sessionId: "sub_" + id, ownerPid: 424242, ownerStart: "live-owner", childPid: 424243, startedAt: Date.now(),
    }));
  }
  vi.spyOn(process, "kill").mockReturnValue(true);
  mockQuery(() => "live-owner", 30);
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  try {
    const first = reapSubagentOrphans(dir);
    expect(reapSubagentOrphans(dir)).toBe(first);
    await first;
    expect(ticked).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 5000, windowsHide: true }), expect.any(Function));
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});
