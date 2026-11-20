import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, createWriteStream, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import { stripVTControlCharacters } from "node:util";
import {
  getAgentDir,
  SettingsManager,
  truncateLine,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { pendingCompletionIds, registerCompletionSource, type Completion } from "../shared/completion-delivery.js";
import { createBackgroundBashOperations, type BackgroundOperations } from "./execution.js";

// ---------------------------------------------------------------------------
// shell-timeout
// ---------------------------------------------------------------------------

/**
 * An explicit lifetime cap the caller actually asked for, in seconds. `0` is a
 * valid explicit value and means "no timeout" (opencode's shell contract);
 * negative, non-finite and non-number values count as absent.
 *
 * background_run keeps no default lifetime: a background task ends when the
 * command exits, when an explicit timeout expires, when background_kill stops
 * it, or when the owning Pi session shuts down. There is also no second hard
 * cap above the explicit value. This mirrors opencode's background shell,
 * where background commands have no timeout by default.
 */
function explicitTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // Pi's shell operations reject anything above this (24.8 days). Clamp instead
  // of starting a task that immediately fails with "Invalid timeout".
  return Math.min(value, PI_MAX_TIMEOUT_SECONDS);
}

const PI_MAX_TIMEOUT_SECONDS = 2_147_483;

// ---------------------------------------------------------------------------
// background manager
// ---------------------------------------------------------------------------

export type BackgroundStatus = "running" | "exited" | "killed" | "failed" | "timed_out";

export interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  parentSessionId: string;
  status: BackgroundStatus;
  exitCode: number | null;
  createdAt: Date;
  outputPath: string;
  lineCount: number;
  tail: string;
  /** True when older output was dropped from the in-memory preview. */
  tailTruncated?: boolean;
  /** Lifetime cap in seconds, when one was explicitly set. */
  timeoutSeconds?: number;
  error?: string;
}

interface InternalTask extends BackgroundTask {
  controller: AbortController;
  notifyOnExit: boolean;
  notified: boolean;
  notificationPending: boolean;
  settledAt?: number;
  done: Promise<void>;
  pidPath: string;
  startPath: string;
  journalPath: string;
}

interface StartOptions {
  /** Hard lifetime cap in seconds; the task is killed when it expires. */
  timeoutSeconds?: number;
  /** Shell operations to run the command with; defaults to bash with no custom shellPath. */
  operations?: BackgroundOperations;
  /** Environment for the child process; omit to let the backend use the default shell env. */
  env?: NodeJS.ProcessEnv;
  /** Prepended to the command (the user's shellCommandPrefix, e.g. venv activation). */
  commandPrefix?: string;
}

/** Recent-output preview held in memory for background_status; the full output lives in the file. */
const TAIL_PREVIEW_CHARS = 4000;
const SETTLED_HISTORY_LIMIT = 100;
const COMPLETION_BATCH_CAP_CHARS = 50_000;
/** Output-file cap: beyond this the file stops growing and a truncation marker is appended. */
export const OUTPUT_FILE_CAP_BYTES = 50 * 1024 * 1024;

const OUTPUT_DIR = join(tmpdir(), "background-terminal");
const TASK_ID_PATTERN = /^bg_[a-f0-9]{16}$/;

function ensureOutputDir(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const info = lstatSync(OUTPUT_DIR);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`background-terminal refuses non-directory state path: ${OUTPUT_DIR}`);
  }
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== uid) {
      throw new Error(`background-terminal refuses state directory owned by another user: ${OUTPUT_DIR}`);
    }
    if ((info.mode & 0o077) !== 0) chmodSync(OUTPUT_DIR, 0o700);
  }
}

function readOwnedStateFile(path: string): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`unsafe background state file: ${path}`);
  if (process.platform !== "win32") {
    const uid = process.getuid?.();
    if (uid === undefined || info.uid !== uid) throw new Error(`foreign background state file: ${path}`);
  }
  return readFileSync(path, "utf8");
}

/** Maximum wait for a task to settle after a stop request. */
const TASK_SETTLE_WAIT_MS = 5_000;

async function waitForTask(done: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), TASK_SETTLE_WAIT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Orphan logs older than this are swept at extension load. With no task lifetime,
 * a live task in another Pi process can be silent for a long time; keep this well
 * above any plausible live task age. $TMPDIR is OS-cleaned eventually. */
const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A spawned wrapper can survive its owner before it has written its PID. */
const ORPHAN_STARTUP_GRACE_MS = 10_000;

/** A log records its notice store because all Pi profiles share the temporary output directory. */
function outputHasPendingNotice(outputPath: string, stores: Map<string, Set<string> | null>): boolean {
  try {
    const marker = outputPath + ".profile";
    const info = lstatSync(marker, { throwIfNoEntry: false });
    if (info && info.size > 32_768) throw new Error("oversized output profile marker: " + marker);
    const storageDir = info ? readOwnedStateFile(marker) : join(getAgentDir(), "completion-notices");
    if (!isAbsolute(storageDir)) throw new Error("invalid output profile marker: " + marker);
    const profile = resolve(storageDir);
    if (!stores.has(profile)) {
      try {
        stores.set(profile, pendingCompletionIds(profile, "background-terminal"));
      } catch (error) {
        stores.set(profile, null);
        console.warn("Could not inspect pending background notices; keeping their logs:", error);
      }
    }
    const pending = stores.get(profile);
    return pending === null || pending!.has(basename(outputPath, ".log"));
  } catch (error) {
    console.warn("Could not inspect background output ownership; keeping log:", error);
    return true;
  }
}

async function removeOutput(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
    await rm(path + ".profile", { force: true });
  } catch {
    // Keep ownership metadata if the log cannot be removed.
  }
}

/**
 * Removes bg_*.log files left behind by crashed Pi processes. Crash paths
 * (uncaughtException, terminal EIO) kill detached children without firing
 * session_shutdown, so the extension's normal cleanup never runs. Files owned by
 * live tasks in this process and logs with a task journal are skipped, including
 * silent tasks still running in another process.
 */
export function sweepOrphanLogs(): void {
  ensureOutputDir();
  let entries: string[];
  try {
    entries = readdirSync(OUTPUT_DIR);
  } catch {
    return; // No dir yet, or unreadable — nothing to sweep.
  }
  const stores = new Map<string, Set<string> | null>();
  const live = new Set([
    ...manager.listAll().map((task) => task.outputPath),
    ...(manager.retiredOutputs?.() ?? []),
  ]);
  const journaled = new Set(
    entries.filter((entry) => entry.startsWith("bg_") && entry.endsWith(".journal.json")).map((entry) => entry.slice(0, -".journal.json".length)),
  );
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  for (const entry of entries) {
    if (entry.startsWith("bg_") && entry.endsWith(".log.profile")) {
      const marker = join(OUTPUT_DIR, entry);
      try {
        if (!lstatSync(marker.slice(0, -".profile".length), { throwIfNoEntry: false }) && lstatSync(marker).mtimeMs < cutoff) rmSync(marker, { force: true });
      } catch {}
      continue;
    }
    if (!entry.startsWith("bg_") || !entry.endsWith(".log")) continue;
    const path = join(OUTPUT_DIR, entry);
    const taskId = entry.slice(0, -".log".length);
    if (live.has(path) || journaled.has(taskId)) continue;
    try {
      if (statSync(path).mtimeMs < cutoff && !outputHasPendingNotice(path, stores)) {
        rmSync(path, { force: true });
        rmSync(path + ".profile", { force: true });
      }
    } catch {
      // A single unreadable/unremovable file must not abort the sweep.
    }
  }
}

/** POSIX single-quote escaping for the wrapper's pid/start files. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const WINDOWS_SYSTEM_DIR = join(process.env.SystemRoot || "C:\\Windows", "System32");
const WINDOWS_POWERSHELL = join(WINDOWS_SYSTEM_DIR, "WindowsPowerShell", "v1.0", "powershell.exe");
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];

function windowsStartCommand(pid: number | string): string {
  return "(Get-Process -Id " + pid + " -ErrorAction Stop).StartTime.ToUniversalTime().Ticks";
}

/** Record the process identity before the prefix or user command can run. */
function wrapCommand(command: string, pidPath: string, startPath: string, taskId: string): string {
  const windows = process.platform === "win32";
  const start = windows
    ? shellQuote(WINDOWS_POWERSHELL.replaceAll("\\", "/")) + ' -NoProfile -NonInteractive -Command "' + windowsStartCommand("$__pi_bg_pid") + '"'
    : 'ps -p "$__pi_bg_pid" -o lstart=';
  return [
    // MSYS/Cygwin PIDs differ from the native PIDs used by Node and taskkill.
    windows ? '__pi_bg_pid=$(cat /proc/$$/winpid 2>/dev/null)' : '__pi_bg_pid=$$',
    'printf \'%s\\n\' "$__pi_bg_pid" > ' + shellQuote(pidPath),
    start + " > " + shellQuote(startPath) + " 2>/dev/null || true",
    "# pi-bg:" + taskId,
    // Keep the native Windows parent alive even when the command uses exec.
    windows ? '(\n' + command + '\n)\n__pi_bg_exit=$?\nexit "$__pi_bg_exit"' : command,
  ].join("\n");
}

function cleanupTaskMeta(task: { pidPath: string; startPath: string; journalPath: string }): void {
  for (const path of [task.journalPath, task.pidPath, task.startPath]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Metadata cleanup must not suppress the completion notification.
    }
  }
}

interface JournalRecord {
  taskId: string;
  ownerPid: number;
  ownerStart?: string;
  command: string;
  outputPath: string;
  pidPath: string;
  startPath: string;
  journalPath: string;
  startedAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A denied probe does not prove the process is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function processStart(pid: number): Promise<string> {
  try {
    const stdout = await execFileAsync(
      process.platform === "win32" ? WINDOWS_POWERSHELL : "ps",
      process.platform === "win32" ? [...POWERSHELL_ARGS, windowsStartCommand(pid)] : ["-p", String(pid), "-o", "lstart="],
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

// Cache the in-flight query too: concurrent task starts share the same OS probe.
let cachedOwnerStart: Promise<string> | undefined;

async function processCommand(pid: number): Promise<string> {
  try {
    const stdout = await execFileAsync(
      process.platform === "win32" ? WINDOWS_POWERSHELL : "ps",
      process.platform === "win32"
        ? [...POWERSHELL_ARGS, "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + pid + "').CommandLine"]
        : ["-p", String(pid), "-o", "command="],
    );
    return stdout;
  } catch {
    return "";
  }
}

async function killTaskTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      await execFileAsync(join(WINDOWS_SYSTEM_DIR, "taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
      return true;
    } catch {
      return !isProcessAlive(pid);
    }
  }
  if (process.platform === "darwin") {
    // Stop the group before a dying child can wake its shell into the next command.
    try {
      process.kill(-pid, "SIGSTOP");
    } catch {}
  }
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return !isProcessAlive(pid);
    }
  }
}

function orphanPaths(taskId: string): { journalPath: string; pidPath: string; startPath: string; outputPath: string } {
  return {
    journalPath: join(OUTPUT_DIR, `${taskId}.journal.json`),
    pidPath: join(OUTPUT_DIR, `${taskId}.pid`),
    startPath: join(OUTPUT_DIR, `${taskId}.start`),
    outputPath: join(OUTPUT_DIR, `${taskId}.log`),
  };
}

function cleanupOrphan(record: Pick<JournalRecord, "taskId" | "journalPath" | "pidPath" | "startPath" | "outputPath">, stores: Map<string, Set<string> | null>): void {
  rmSync(record.journalPath, { force: true });
  rmSync(record.pidPath, { force: true });
  rmSync(record.startPath, { force: true });
  if (!outputHasPendingNotice(record.outputPath, stores)) {
    rmSync(record.outputPath, { force: true });
    rmSync(record.outputPath + ".profile", { force: true });
  }
}

let reaping: Promise<void> | undefined;

/**
 * Kill tasks left behind by a Pi process that was SIGKILLed or crashed. The
 * owner PID/start pair is checked before verifying the child identity. Legacy
 * records and unknown owner identities retain the conservative PID-only check.
 */
export function reapOrphans(): Promise<void> {
  if (reaping) return reaping;
  ensureOutputDir();
  reaping = reapOrphanPass().finally(() => { reaping = undefined; });
  return reaping;
}

async function reapOrphanPass(): Promise<void> {
  const stores = new Map<string, Set<string> | null>();
  // Reuse identities only within this pass; a later pass must detect PID reuse.
  const processes = new Map<number, { alive: boolean; start?: Promise<string>; command?: Promise<string>; killed?: Promise<boolean> }>();
  const probe = (pid: number) => {
    let entry = processes.get(pid);
    if (!entry) {
      entry = { alive: isProcessAlive(pid) };
      processes.set(pid, entry);
    }
    return entry;
  };
  let names: string[];
  try {
    names = readdirSync(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("bg_") || !name.endsWith(".journal.json")) continue;
    const journalPath = join(OUTPUT_DIR, name);
    try {
      const parsed = JSON.parse(readOwnedStateFile(journalPath)) as Partial<JournalRecord>;
      const id = name.slice(0, -".journal.json".length);
      if (!TASK_ID_PATTERN.test(id) || parsed.taskId !== id) continue;
      if (!Number.isInteger(parsed.ownerPid) || (parsed.ownerPid ?? 0) <= 0) continue;
      const paths = orphanPaths(id);
      const record: JournalRecord = {
        taskId: id,
        ownerPid: parsed.ownerPid!,
        ownerStart: typeof parsed.ownerStart === "string" ? parsed.ownerStart.trim() : "",
        command: typeof parsed.command === "string" ? parsed.command : "",
        outputPath: paths.outputPath,
        pidPath: paths.pidPath,
        startPath: paths.startPath,
        journalPath,
        startedAt: typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) ? parsed.startedAt : 0,
      };
      const owner = probe(record.ownerPid);
      if (owner.alive) {
        if (!record.ownerStart) continue;
        const currentOwnerStart = await (owner.start ??= processStart(record.ownerPid));
        if (!currentOwnerStart || currentOwnerStart === record.ownerStart) continue;
      }

      let pid = 0;
      try {
        pid = Number(readOwnedStateFile(record.pidPath).trim());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      const hasPid = Number.isInteger(pid) && pid > 0;
      if (!hasPid && record.startedAt > 0 && Date.now() - record.startedAt < ORPHAN_STARTUP_GRACE_MS) continue;
      if (!hasPid || !probe(pid).alive) {
        cleanupOrphan(record, stores);
        continue;
      }

      let recordedStart = "";
      try {
        recordedStart = readOwnedStateFile(record.startPath).trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      const child = probe(pid);
      const currentStart = await (child.start ??= processStart(pid));
      const verified = recordedStart !== "" && currentStart !== ""
        ? currentStart === recordedStart
        : (await (child.command ??= processCommand(pid))).includes(`pi-bg:${id}`);
      // Keep unverifiable or unkillable tasks journaled so a later load can retry.
      if (verified && await (child.killed ??= killTaskTree(pid))) cleanupOrphan(record, stores);
    } catch {
      // Corrupt journal or a filesystem race: leave it for the next load.
    }
  }
}

export class BackgroundManager {
  private readonly tasks = new Map<string, InternalTask>();
  private readonly retiredOutputPaths = new Map<string, Set<string>>();
  private onExit?: (task: BackgroundTask) => void;
  private onChange?: () => void;

  /** Registers callbacks for completion notifications and task-count changes. */
  init(onExit: (task: BackgroundTask) => void, onChange?: () => void): void {
    this.onExit = onExit;
    this.onChange = onChange;
  }

  /**
   * Starts a command in the background and returns immediately with its task info.
   * Output streams to a file on disk until the command exits or the owning Pi session ends.
   */
  start(command: string, cwd: string, parentSessionId: string, options?: StartOptions): BackgroundTask {
    return this.toPublic(this.spawn(command, cwd, parentSessionId, options));
  }

  private spawn(command: string, cwd: string, parentSessionId: string, options?: StartOptions): InternalTask {
    ensureOutputDir();
    const id = `bg_${randomBytes(8).toString("hex")}`;
    const outputPath = join(OUTPUT_DIR, `${id}.log`);
    const pidPath = join(OUTPUT_DIR, `${id}.pid`);
    const startPath = join(OUTPUT_DIR, `${id}.start`);
    const journalPath = join(OUTPUT_DIR, `${id}.journal.json`);
    // Create the file synchronously so callers can rely on it existing the moment start() returns;
    // createWriteStream opens asynchronously and would otherwise race the caller.
    writeFileSync(outputPath, "", { flag: "wx", mode: 0o600 });
    try {
      writeFileSync(outputPath + ".profile", resolve(getAgentDir(), "completion-notices"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      rmSync(outputPath, { force: true });
      throw error;
    }
    const fileStream = createWriteStream(outputPath, { flags: "a" });
    const controller = new AbortController();
    const decoder = new StringDecoder("utf8");

    const task: InternalTask = {
      id,
      command,
      cwd,
      parentSessionId,
      status: "running",
      exitCode: null,
      createdAt: new Date(),
      outputPath,
      lineCount: 0,
      tail: "",
      tailTruncated: false,
      timeoutSeconds: options?.timeoutSeconds,
      controller,
      notifyOnExit: true,
      notified: false,
      notificationPending: false,
      done: Promise.resolve(),
      pidPath,
      startPath,
      journalPath,
    };

    // Without this, a write failure (ENOSPC/EACCES on a long-lived task) is an unhandled stream
    // error, which Node promotes to an uncaught exception that takes down the whole Pi process.
    fileStream.on("error", (error) => {
      task.error = `output file write failed: ${error instanceof Error ? error.message : String(error)}`;
      controller.abort();
    });
    // Output-file cap: a pathological producer (`yes`) can otherwise write tens of GB.
    // Past the cap the file stops growing and a marker line records what was dropped;
    // the task itself keeps running to its exit or explicit timeout.
    let fileBytes = 0;
    let fileCapped = false;

    const ops = options?.operations ?? createBackgroundBashOperations(killTaskTree);
    const outputClosed = finished(fileStream, { cleanup: true }).catch(() => {});
    // The journal lets the next extension load kill a task whose owner Pi was
    // SIGKILLed or crashed (session_shutdown cannot run on those paths).
    const execution = (async () => {
      const ownerStart = await (cachedOwnerStart ??= processStart(process.pid));
      controller.signal.throwIfAborted();
      writeFileSync(
        journalPath,
        JSON.stringify({
          taskId: id,
          ownerPid: process.pid,
          ownerStart,
          command,
          outputPath,
          pidPath,
          startPath,
          startedAt: Date.now(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      const wrapped = wrapCommand(options?.commandPrefix ? options.commandPrefix + "\n" + command : command, pidPath, startPath, id);
      return ops.exec(wrapped, cwd, {
        signal: controller.signal,
        env: options?.env,
        // The backend owns the explicit lifetime and kills the process tree on timeout.
        timeout: options?.timeoutSeconds && options.timeoutSeconds > 0 ? options.timeoutSeconds : undefined,
        onData: (chunk) => {
          this.appendTail(task, decoder.write(chunk));
          if (fileCapped) return;
          if (task.error) throw new Error(task.error);
          const remaining = OUTPUT_FILE_CAP_BYTES - fileBytes;
          const kept = chunk.subarray(0, remaining);
          let ready = kept.length === 0 || fileStream.write(kept);
          fileBytes += kept.length;
          if (chunk.length > remaining) {
            fileCapped = true;
            ready = fileStream.write("\n[output truncated at " + OUTPUT_FILE_CAP_BYTES + " bytes; further bytes dropped, producer kept running]\n") && ready;
          }
          if (!ready) return once(fileStream, "drain").then(() => {});
        },
      });
    })()
      .then(({ exitCode }) => {
        task.status = task.error ? "failed" : "exited";
        task.exitCode = exitCode;
      })
      .catch((error) => {
        if (task.error) {
          task.status = "failed";
        } else if (error instanceof Error && error.message.startsWith("timeout:")) {
          task.status = "timed_out";
        } else if (controller.signal.aborted) {
          task.status = "killed";
        } else {
          task.status = "failed";
          task.error = error instanceof Error ? error.message : String(error);
        }
      });

    task.done = execution
      .then(() => {
        this.appendTail(task, decoder.end());
        fileStream.end();
        return outputClosed;
      })
      .then(() => {
        if (task.error) task.status = "failed";
        task.settledAt = Date.now();
        cleanupTaskMeta(task);
        this.emitChange();
        this.maybeNotify(task);
      })
      // A throwing onExit would otherwise be an unhandled rejection, which Node promotes to an
      // uncaught exception; a failed notification must not take down the host process.
      .catch(() => {});

    this.tasks.set(id, task);
    this.emitChange();
    return task;
  }

  get(id: string, parentSessionId: string): BackgroundTask | null {
    const task = this.tasks.get(id);
    if (!task || task.parentSessionId !== parentSessionId) return null;
    return this.toPublic(task);
  }

  list(parentSessionId: string): BackgroundTask[] {
    return this.listAll().filter((task) => task.parentSessionId === parentSessionId);
  }

  /** All tasks across sessions — used by the orphan sweep to protect live output files. */
  listAll(): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((task) => this.toPublic(task));
  }

  kill(id: string, parentSessionId: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.parentSessionId !== parentSessionId) return false;
    if (task.status !== "running") return false;
    // A stopped task still reports its outcome; only session cleanup is silent
    // (the session is ending, so there is no recipient).
    task.controller.abort();
    return true;
  }

  async stopAndWait(id: string, sessionId: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || !this.kill(id, sessionId)) throw new Error("Background command is no longer running in this session.");
    if (!(await waitForTask(task.done)) || task.status !== "killed") {
      throw new Error("Background command termination could not be confirmed.");
    }
  }

  private maybeNotify(task: InternalTask): void {
    if (task.notified) return;
    if (!task.notifyOnExit) return;
    task.notified = true;
    task.notificationPending = true;
    this.onExit?.(this.toPublic(task));
    this.pruneSettledHistory();
  }

  retiredOutputs(): string[] {
    return Array.from(this.retiredOutputPaths.values()).flatMap((paths) => Array.from(paths));
  }

  pendingNotifications(parentSessionId: string): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .filter((task) => task.parentSessionId === parentSessionId && task.notificationPending)
      .map((task) => this.toPublic(task));
  }

  notificationDelivered(id: string): void {
    const task = this.tasks.get(id);
    if (task) task.notificationPending = false;
    this.pruneSettledHistory();
  }

  private pruneSettledHistory(): void {
    const removable = Array.from(this.tasks.values())
      .filter((task) => task.status !== "running" && task.notified && !task.notificationPending)
      .sort((a, b) => (a.settledAt ?? a.createdAt.getTime()) - (b.settledAt ?? b.createdAt.getTime()));
    for (const task of removable.slice(0, -SETTLED_HISTORY_LIMIT)) {
      this.tasks.delete(task.id);
      const paths = this.retiredOutputPaths.get(task.parentSessionId) ?? new Set<string>();
      paths.add(task.outputPath);
      this.retiredOutputPaths.set(task.parentSessionId, paths);
    }
  }

  async clearSession(parentSessionId: string, preservePending = false): Promise<void> {
    const tasks = Array.from(this.tasks.values()).filter((task) => task.parentSessionId === parentSessionId);
    const retiredOutputs = this.retiredOutputPaths.get(parentSessionId) ?? new Set<string>();
    this.retiredOutputPaths.delete(parentSessionId);

    for (const task of tasks) {
      task.notifyOnExit = false;
      if (task.status === "running") task.controller.abort();
      this.tasks.delete(task.id);
    }

    await Promise.all([
      ...tasks.map(async (task) => {
        // Do not hang Pi forever on a process that refuses to die. If the wait
        // times out, the journal stays and the next-start reaper kills it.
        if (!(await waitForTask(task.done))) return;
        cleanupTaskMeta(task);
        if (!preservePending || !task.notificationPending) {
          await removeOutput(task.outputPath);
        }
      }),
      ...Array.from(retiredOutputs, removeOutput),
    ]);
  }

  private emitChange(): void {
    try {
      this.onChange?.();
    } catch {
      // UI callbacks must not disrupt process lifecycle.
    }
  }

  private appendTail(task: InternalTask, chunk: string): void {
    task.lineCount += (chunk.match(/\n/g) ?? []).length;
    const combined = task.tail + chunk;
    if (combined.length > TAIL_PREVIEW_CHARS) task.tailTruncated = true;
    task.tail = combined.slice(-TAIL_PREVIEW_CHARS);
  }

  private toPublic(task: InternalTask): BackgroundTask {
    const {
      controller: _controller,
      notifyOnExit: _notifyOnExit,
      notified: _notified,
      notificationPending: _notificationPending,
      settledAt: _settledAt,
      done: _done,
      pidPath: _pidPath,
      startPath: _startPath,
      journalPath: _journalPath,
      ...publicTask
    } = task;
    return publicTask;
  }
}

// Pi's /reload re-imports every extension through jiti with `moduleCache: false`, which
// re-evaluates this module. A plain module-level instance would therefore be replaced on every
// /reload, orphaning tasks started before it: invisible to background_status, unstoppable by
// background_kill, and never notified. Pinning to a process global keeps one manager across
// re-imports. Tasks stay isolated by parentSessionId, so sharing one manager is safe.
//
// Changing the global state contract requires a Pi restart, not a live upgrade.
const MANAGER_KEY = Symbol.for("@bytetrue/pi-background-terminal.manager.v2");
const globalStore = globalThis as unknown as Record<symbol, BackgroundManager | undefined>;
export const manager = (globalStore[MANAGER_KEY] ??= new BackgroundManager());

// ---------------------------------------------------------------------------
// background work registry (cross-extension, optional)
// ---------------------------------------------------------------------------
// goal (E6) and subagent (D10) need to know what is still running in a session.
// pi has no job service, so the extensions that own background work publish a
// provider here. The registry is process-global and keyed by extension id, so a
// `/reload` replaces a provider instead of stacking duplicates; consumers that
// load without any provider simply see no running work.
//
// Contract: `running(sessionId)` returns only work that is still running and
// belongs to that session. Providers must be cheap and side-effect free.
export interface BackgroundWorkItem {
  kind: "shell" | "subagent";
  id: string;
  label: string;
}

export interface BackgroundWorkProvider {
  running(sessionId: string): BackgroundWorkItem[];
}

const WORK_REGISTRY_KEY = Symbol.for("pi-extensions.background-work");
const workGlobal = globalThis as unknown as Record<
  symbol,
  Map<string, BackgroundWorkProvider> | undefined
>;
const workProviders = (workGlobal[WORK_REGISTRY_KEY] ??= new Map<string, BackgroundWorkProvider>());

export function registerBackgroundWorkProvider(
  id: string,
  running: (sessionId: string) => BackgroundWorkItem[],
): void {
  workProviders.set(id, { running });
}

/** Read-only view for other extensions; missing providers mean no running work. */
export function runningBackgroundWork(sessionId: string): BackgroundWorkItem[] {
  const items: BackgroundWorkItem[] = [];
  for (const provider of workProviders.values()) {
    try {
      items.push(...provider.running(sessionId));
    } catch {
      // A broken provider must not take the goal loop or a completion notice down.
    }
  }
  return items;
}

registerBackgroundWorkProvider("background-terminal", (sessionId) =>
  manager
    .list(sessionId)
    .filter((task) => task.status === "running")
    .map((task) => ({ kind: "shell", id: task.id, label: task.command })),
);

// ---------------------------------------------------------------------------
// background_run
// ---------------------------------------------------------------------------

/**
 * `background_run` — a pure background executor. It never waits, never returns command
 * output inline; it starts the command and returns a task id immediately. The exit
 * (natural, failed, or an explicit lifetime expiry) wakes the agent with a completion notice.
 *
 * opencode's background shell has no timeout by default and treats an explicit timeout
 * as the only lifetime bound; this tool does the same. Pi's session shutdown is the real
 * cleanup boundary: every task the session started is killed when the session ends, so
 * "no default lifetime" cannot leave a process behind after Pi exits. A timed-out dev
 * server renews by restarting (the wake-up message says so).
 *
 * Exit notifications share one continuation per batch with subagent results.
 *
 * This being a pure background tool, print/json sessions (pi -p, subagent children)
 * need no special-casing: there is no wait to keep alive. The task runs while the
 * session lives and dies with the Pi process — in pi -p the process exits with the
 * turn (the exit notification cannot arrive), in TUI/RPC it fires normally.
 */
export function registerBackgroundRunTool(pi: ExtensionAPI): void {
  let cached: {
    key: string;
    settings: { commandPrefix?: string; shellPath?: string };
  } | null = null;

  pi.registerTool({
    name: "background_run",
    label: "Run Command in Background",
    description: `Starts a shell command in the background and returns immediately with a task id; the command keeps running on its own. Use it for work that should run hands-off — builds, test suites, dev servers, watch mode. When you need the output to decide your next step, use bash instead. After it starts, continue with other work or end your turn: its exit — natural, failed, or timed-out — arrives as a new message that starts your next turn. That notification is how you wait. There is no lifetime by default; pass timeout to set one (0 also means no timeout), and a task that hits it is killed and reported. Full output streams to a file (path in the result); use read on that path.`,
    promptSnippet: `Start a command in the background; its exit arrives later as a new message. Use bash when you need the result now.`,
    // Positive-first wording (decision 001): each line says what to do; the wait model is stated
    // explicitly because a bare "do not poll" left a vacuum the model filled with `sleep`.
    promptGuidelines: [
      "Use background_run for work that should run hands-off — builds, test suites, dev servers, watch mode — anything you can leave running while you do other things",
      "When you need a command's output to decide your next step, use bash — it blocks and returns the output",
      "After background_run returns, the command is already running: continue with other work or end your turn. Its exit arrives as a new message that starts your next turn — that notification is how you wait. background_status is for a one-off look at partial output, not a polling loop",
      "There is no lifetime by default; pass timeout (seconds) only when the command must be killed at a bound, and restart with background_run when that timeout notification arrives to renew a long-running service. Pi kills every task when the session exits",
      "The optional bash-timeout extension gives bash/powershell a 2-minute foreground default; when a command needs longer, run it with background_run instead of blocking on bash",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "The shell command to run in the background" }),
      timeout: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 2147483,
          description:
            "Lifetime cap in seconds. Omit or pass 0 for no timeout; a positive value kills the task when it expires and the completion notice says so. Negative or non-finite values are treated as absent.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Settings are resolved from the live ctx: an untrusted project's settings must not
      // influence shell resolution here, exactly like Pi's own built-in creation.
      const key = `${ctx.isProjectTrusted() ? "t" : "u"}:${ctx.cwd}`;
      if (cached?.key !== key) {
        cached = { key, settings: resolveShellOptions(ctx.cwd, ctx.isProjectTrusted()) };
      }
      const timeoutSeconds = explicitTimeout(params.timeout);
      const task = manager.start(params.command, ctx.cwd, ctx.sessionManager.getSessionId(), {
        timeoutSeconds,
        operations: createBackgroundBashOperations(killTaskTree, cached.settings.shellPath),
        env: sessionEnv(ctx),
        commandPrefix: cached.settings.commandPrefix,
      });
      const lifetime =
        timeoutSeconds && timeoutSeconds > 0
          ? `Lifetime: ${timeoutSeconds}s; it will be killed if it runs longer.`
          : "No lifetime cap; it runs until it exits or the session ends.";
      return {
        content: [
          {
            type: "text",
            text: [
              `Started in background: ${task.id}`,
              `status: running`,
              `Output file: ${task.outputPath}`,
              lifetime,
              "Its exit will arrive as a new message. Do not poll or sleep on it: continue with other work, or end your turn if there is nothing else to do.",
            ].join("\n"),
          },
        ],
        details: task,
      };
    },
  });
}

function resolveShellOptions(cwd: string, trusted: boolean): { commandPrefix?: string; shellPath?: string } {
  // The built-in shell tools run with the user's shellPath / shellCommandPrefix settings;
  // the extension API does not expose the live SettingsManager, so read the same files
  // through SettingsManager itself, honoring the project-trust decision. A broken settings
  // file must not take the extension down — fall back to defaults.
  try {
    const settings = SettingsManager.create(cwd, undefined, { projectTrusted: trusted });
    return {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath() ?? undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Mirrors the built-in tool's session environment (PI_SESSION_ID and friends) plus the
 * agent bin dir prepended to PATH — the built-in does this via getShellEnv()
 * (dist/utils/shell.js), which is not exported from the package entry. Replicated here
 * (six lines, same semantics: prepend only when absent, case-insensitive PATH key on
 * Windows). Upgrade trigger: switch to the upstream export if one ever appears.
 */
function sessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;

  const binDir = join(getAgentDir(), "bin");
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  if (currentPath.split(delimiter).filter(Boolean).includes(binDir)) {
    env[pathKey] = currentPath;
  } else {
    env[pathKey] = [binDir, currentPath].filter(Boolean).join(delimiter);
  }
  return env;
}

// ---------------------------------------------------------------------------
// background_status
// ---------------------------------------------------------------------------

export function registerBackgroundStatusTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "background_status",
    label: "Background Task Status",
    description:
      "Check a background task by id. Returns status, exit code, output-file path, line count, and recent output. Read the file for full output; completion is reported automatically, so don't poll.",
    promptSnippet: "Check one background task.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Task id from background_run." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const task = manager.get(params.id, parentSessionId);
      if (!task) throw new Error(`No background task found with id "${params.id}".`);

      const text = [
        formatSummary(task),
        `Output file: ${task.outputPath}`,
        `Lines so far: ${task.lineCount}`,
        task.status === "running"
          ? task.tail
            ? `Output so far (still running):\n${stripTerminal(task.tail)}`
            : "(no output yet, still running)"
          : task.tail
            ? `Recent output:\n${stripTerminal(task.tail)}`
            : "(no output)",
        "Use the read tool on the output file path above to see the full output.",
      ].join("\n");

      return { content: [{ type: "text", text }], details: task };
    },
  });
}

function formatSummary(task: BackgroundTask): string {
  const parts = [`[${task.id}] ${task.command}`, `status: ${task.status}`];
  if (task.exitCode !== null) parts.push(`exitCode: ${task.exitCode}`);
  if (task.error) parts.push(`error: ${task.error}`);
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------
// background_kill
// ---------------------------------------------------------------------------

export function registerBackgroundKillTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "background_kill",
    label: "Stop Background Task",
    description: "Stop a running background task by id.",
    promptSnippet: "Stop one background task.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Task id from background_run." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parentSessionId = ctx.sessionManager.getSessionId();
      const task = manager.get(params.id, parentSessionId);
      if (!task) throw new Error(`No background task found with id "${params.id}".`);
      if (task.status !== "running") {
        return {
          content: [{ type: "text", text: `[${task.id}] is already ${task.status}; nothing to stop.` }],
          details: task,
        };
      }

      await manager.stopAndWait(params.id, parentSessionId);

      return {
        content: [{ type: "text", text: `Stopped ${task.id} (${task.command}).` }],
        details: manager.get(params.id, parentSessionId) ?? task,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// /background menu
// ---------------------------------------------------------------------------

const BACK = "Back";
const VIEW_OUTPUT = "View output";
const KILL = "Kill";

export async function runBackgroundCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) return;

  const sessionId = ctx.sessionManager.getSessionId();
  while (true) {
    const tasks = manager.list(sessionId).filter((task) => task.status === "running");
    if (tasks.length === 0) {
      ctx.ui.notify("No running background commands.", "info");
      return;
    }

    const taskOptions = tasks.map(formatTaskOption);
    const selected = await ctx.ui.select("Background commands", [...taskOptions, BACK]);
    if (!selected || selected === BACK) return;

    const task = tasks[taskOptions.indexOf(selected)];
    if (!task) continue;
    await runTaskMenu(ctx, task, sessionId);
  }
}

function registerBackgroundCommand(pi: ExtensionAPI): void {
  pi.registerCommand("background", {
    description: "Browse running background commands, view their output, or stop one",
    handler: async (_args, ctx) => runBackgroundCommand(ctx),
  });
}

async function runTaskMenu(ctx: ExtensionCommandContext, task: BackgroundTask, sessionId: string): Promise<void> {
  while (true) {
    const current = manager.get(task.id, sessionId) ?? task;
    const actions = [VIEW_OUTPUT];
    if (current.status === "running") actions.push(KILL);
    actions.push(BACK);

    const action = await ctx.ui.select(`${current.command} — ${current.status}`, actions);
    if (!action || action === BACK) return;

    if (action === VIEW_OUTPUT) {
      await showOutput(ctx, current);
      continue;
    }

    if (action === KILL) {
      const confirmed = await ctx.ui.confirm("Stop this background command?", current.command);
      if (!confirmed) continue;
      try {
        await manager.stopAndWait(current.id, sessionId);
        ctx.ui.notify("Background command stopped.", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
      return;
    }
  }
}

async function showOutput(ctx: ExtensionCommandContext, task: BackgroundTask): Promise<void> {
  const output = [
    `Output file: ${task.outputPath}`,
    "The log saves the first 50 MiB; any file truncation is marked in the log.",
    `Recent output (last ${NOTIFICATION_TAIL_LINES} lines, up to ${TAIL_PREVIEW_CHARS} characters):`,
    formatNotificationOutput(task),
  ].join("\n\n");
  await ctx.ui.editor(`Output preview — ${truncateLine(task.command.replace(/\s+/g, " ").trim(), 100).text}`, output);
}

function formatTaskOption(task: BackgroundTask): string {
  const command = truncateLine(task.command.replace(/\s+/g, " ").trim(), 100).text;
  return `[${task.status}] ${command} — ${task.id}`;
}

// ---------------------------------------------------------------------------
// extension entry point
// ---------------------------------------------------------------------------

export default function registerBackgroundTerminal(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("background-exit", (message, { expanded, outputPad, keyText }, theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const label = theme.bold(theme.fg("customMessageLabel", `[${message.customType}]`));
    const details = message.details as Partial<BackgroundTask> | Partial<BackgroundTask>[] | undefined;
    const detail = Array.isArray(details) ? undefined : details;
    const state = detail && notificationState(detail);
    const fallback = content.split("\n").find((line) => line.trim() && !line.trimStart().startsWith("<")) ?? "(no output)";
    const summary = truncateLine(
      detail?.id
        ? `${detail.id}${state ? ` ${state}` : ""}${detail.command ? ` — ${detail.command}` : ""}`
        : fallback,
      120,
    ).text;
    const text = expanded
      ? `${label}\n${content}`
      : `${label} ${summary} ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`;
    const box = new Box(outputPad, 1, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
  let currentSessionId: string | null = null;
  let updateStatus: (() => void) | undefined;
  let agentBusy = false;
  const pendingKey = Symbol.for("@bytetrue/pi-background-terminal.pending-exits.v2");
  const pendingStore = globalThis as unknown as Record<symbol, BackgroundTask[] | undefined>;
  const pendingExits = (pendingStore[pendingKey] ??= []);
  const enqueueExit = (task: BackgroundTask) => {
    const index = pendingExits.findIndex((pending) => pending.id === task.id && pending.parentSessionId === task.parentSessionId);
    if (index >= 0) pendingExits[index] = task;
    else pendingExits.push(task);
    try {
      const completion = completionEntries([task])[0]!;
      completion.message.details = summaryDetails(task);
      delivery.persist(task.parentSessionId, completion);
    } catch (error) {
      console.warn(`Could not persist background completion ${task.id}: ${error}`);
    }
  };

  const completionEntries = (batch: BackgroundTask[]): Completion[] => {
    if (batch.length === 0) return [];
    return formatCompletionBatches(batch).map((completion) => {
      const tasks = completion.tasks;
      return {
        ids: tasks.map((task) => task.id),
        message: {
          customType: "background-exit",
          content: completion.content,
          display: true,
          details: completion.summarized
            ? tasks.length === 1 ? summaryDetails(tasks[0]!) : tasks.map(summaryDetails)
            : tasks.length === 1 ? tasks[0] : tasks,
        },
        delivered: () => {
          for (const task of tasks) {
            manager.notificationDelivered(task.id);
            const index = pendingExits.findIndex((pending) => pending.id === task.id && pending.parentSessionId === task.parentSessionId);
            if (index >= 0) pendingExits.splice(index, 1);
          }
        },
      };
    });
  };
  const delivery = registerCompletionSource("background-terminal", {
    storageDir: join(getAgentDir(), "completion-notices"),
    sessionId: () => currentSessionId,
    send: (message, options) => pi.sendMessage(message, options),
    pending: (sessionId) => completionEntries(pendingExits.filter((task) => task.parentSessionId === sessionId)),
  });
  const flushPendingExits = (triggerTurn = true) => {
    try {
      delivery.flush(triggerTurn);
    } catch (error) {
      console.warn("Could not deliver background completions:", error);
    }
  };

  manager.init(
    (task) => {
      enqueueExit(task);
      if (!currentSessionId || task.parentSessionId !== currentSessionId) return;
      if (!agentBusy) delivery.schedule();
    },
    () => updateStatus?.(),
  );

  pi.events?.on("bytetrue.background-terminal.manage", (value) => {
    const request = value as { sessionId: string; taskId?: string; respond: (result: Promise<unknown>) => void };
    if (!request || typeof request.respond !== "function" || !currentSessionId || request.sessionId !== currentSessionId) return;
    const sessionId = currentSessionId;
    request.respond((async () => {
      if (request.taskId !== undefined) {
        await manager.stopAndWait(request.taskId, sessionId);
      }
      return manager.list(sessionId).map(({ id, command, status, createdAt }) => ({ id, command, status, createdAt }));
    })());
  });
  registerBackgroundCommand(pi);
  // No foreground-timeout hook here: the default for bash/powershell lives in the
  // separate bash-timeout extension, so an install of this package contains no hook
  // source at all.
  registerBackgroundRunTool(pi);
  registerBackgroundStatusTool(pi);
  registerBackgroundKillTool(pi);

  pi.on("agent_start", async () => {
    delivery.cancel();
    agentBusy = true;
  });

  // A goal loop keeps `agentBusy` true across continuations and only settles
  // when the whole loop stops. Flush at each turn boundary so a finished
  // command reaches the next continuation instead of waiting for the goal to end.
  pi.on("turn_end", async () => {
    flushPendingExits();
  });

  pi.on("agent_settled", async () => {
    agentBusy = false;
    flushPendingExits();
  });

  pi.on("session_start", async (_event, ctx) => {
    // Recover crashed owners before new work, without blocking timers or the UI.
    await reapOrphans();
    sweepOrphanLogs();
    const sessionId = ctx.sessionManager.getSessionId();
    agentBusy = false;
    currentSessionId = sessionId;
    for (const task of manager.pendingNotifications(sessionId)) enqueueExit(task);
    updateStatus = () => {
      const running = manager.list(sessionId).filter((task) => task.status === "running").length;
      ctx.ui.setStatus("background-terminal", running === 0 ? undefined : `bg:${running}`);
    };
    updateStatus();
    if (!agentBusy) delivery.schedule();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    delivery.cancel();
    // "reload" re-fires session_shutdown/session_start on the SAME session (extensions and config
    // hot-reload), it does not end the session. Background tasks must survive a /reload.
    if (event.reason === "reload") {
      flushPendingExits();
      currentSessionId = null;
      updateStatus = undefined;
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    ctx.ui.setStatus("background-terminal", undefined);
    updateStatus = undefined;
    if (currentSessionId === sessionId) currentSessionId = null;
    await manager.clearSession(sessionId, true);
  });
}

function notificationState(task: Pick<Partial<BackgroundTask>, "status" | "error">): string | undefined {
  return task.status === "exited" ? task.error ? "failed" : "completed" : task.status;
}

function formatExitMessage(task: BackgroundTask): string {
  const state = notificationState(task);
  const body: string[] = [formatNotificationOutput(task)];

  if (task.status === "timed_out") {
    body.push(
      `Timed out after ${task.timeoutSeconds ?? "?"} seconds. Do not start another copy while it is still being stopped; restart with background_run to renew it if the service should keep running.`,
    );
  } else if (task.status === "failed") {
    body.push(`Error: ${task.error ?? "unknown error"}`);
  } else if (task.status === "killed") {
    body.push("The task was stopped.");
  }
  if (task.error && task.status !== "failed") body.push(`Error: ${task.error}`);
  if (task.exitCode !== null) body.push(`Exit code: ${task.exitCode}`);
  body.push(`Full output: ${task.outputPath}`);

  return `<shell id="${escapeAttribute(task.id)}" state="${state}" command="${escapeAttribute(task.command)}">\n${body.join("\n\n")}\n</shell>`;
}

interface CompletionMessage {
  content: string;
  tasks: BackgroundTask[];
  summarized: boolean;
}

function summaryDetails(task: BackgroundTask): Record<string, unknown> {
  return {
    id: task.id,
    parentSessionId: task.parentSessionId,
    status: task.status,
    exitCode: task.exitCode,
    outputPath: task.outputPath,
    ...(task.error ? { error: truncateLine(task.error, 200).text } : {}),
  };
}

function formatCompletionBatches(batch: BackgroundTask[]): CompletionMessage[] {
  let full = batch.length === 1 ? "" : `${batch.length} background tasks finished:\n\n`;
  for (let index = 0; index < batch.length; index++) {
    const separator = batch.length > 1 && index > 0 ? "\n\n" : "";
    const formatted = formatExitMessage(batch[index]!);
    if (full.length + separator.length + formatted.length > COMPLETION_BATCH_CAP_CHARS) {
      return summarizeCompletionBatches(batch);
    }
    full += separator + formatted;
  }
  return [{ content: full, tasks: batch, summarized: false }];
}

function summarizeCompletionBatches(batch: BackgroundTask[]): CompletionMessage[] {
  const header = `${batch.length} background tasks finished; output summarized to bound this notice:`;
  const messages: CompletionMessage[] = [];
  let content = header;
  let tasks: BackgroundTask[] = [];
  for (const task of batch) {
    const error = task.error ? `; Error: ${truncateLine(task.error, 200).text}` : "";
    const raw = `- ${task.id}: ${notificationState(task)}; Output: ${task.outputPath}${error}`;
    const line = raw.length > COMPLETION_BATCH_CAP_CHARS - header.length - 100
      ? truncateLine(raw, COMPLETION_BATCH_CAP_CHARS - header.length - 100).text
      : raw;
    if (tasks.length > 0 && content.length + line.length + 1 > COMPLETION_BATCH_CAP_CHARS) {
      messages.push({ content, tasks, summarized: true });
      content = header;
      tasks = [];
    }
    content += `\n${line}`;
    tasks.push(task);
  }
  if (tasks.length > 0) messages.push({ content, tasks, summarized: true });
  return messages;
}

const NOTIFICATION_TAIL_LINES = 50;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip terminal control sequences from model-facing output; the raw stream
 * stays in the output file for `read`. */
function stripTerminal(text: string): string {
  return stripVTControlCharacters(text).replace(CONTROL_PATTERN, "");
}

/** Bounded tail for completion notices and the output menu; the log is capped separately. */
function formatNotificationOutput(task: BackgroundTask): string {
  const raw = stripTerminal(task.tail).replace(/\s+$/, "");
  if (!raw) return "(no output)";
  const all = raw.split("\n");
  const truncatedByLines = all.length > NOTIFICATION_TAIL_LINES;
  const lines = truncatedByLines ? all.slice(-NOTIFICATION_TAIL_LINES) : all;
  const text = lines.join("\n").slice(-TAIL_PREVIEW_CHARS);
  const truncated = Boolean(task.tailTruncated) || truncatedByLines;
  return truncated ? `[earlier output omitted]\n${text}` : text;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
