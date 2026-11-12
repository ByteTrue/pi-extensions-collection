import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import {
  createLocalBashOperations,
  SettingsManager,
  truncateLine,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
  done: Promise<void>;
  pidPath: string;
  startPath: string;
  journalPath: string;
}

interface StartOptions {
  /** Hard lifetime cap in seconds; the task is killed when it expires. */
  timeoutSeconds?: number;
  /** Shell operations to run the command with; defaults to bash with no custom shellPath. */
  operations?: BashOperations;
  /** Environment for the child process; omit to let the backend use the default shell env. */
  env?: NodeJS.ProcessEnv;
  /** Prepended to the command (the user's shellCommandPrefix, e.g. venv activation). */
  commandPrefix?: string;
}

/** Recent-output preview held in memory for background_status; the full output lives in the file. */
const TAIL_PREVIEW_CHARS = 4000;
/** Output-file cap: beyond this the file stops growing and a truncation marker is appended. */
export const OUTPUT_FILE_CAP_BYTES = 50 * 1024 * 1024;

const OUTPUT_DIR = join(tmpdir(), "background-terminal");
/** How long a session shutdown waits for a killed task before letting Pi exit.
 * A task that survives this wait stays in the journal for the next-start reaper. */
const SHUTDOWN_WAIT_MS = 5_000;
/** Orphan logs older than this are swept at extension load. With no task lifetime,
 * a live task in another Pi process can be silent for a long time; keep this well
 * above any plausible live task age. $TMPDIR is OS-cleaned eventually. */
const ORPHAN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes bg_*.log files left behind by crashed Pi processes. Crash paths
 * (uncaughtException, terminal EIO) kill detached children without firing
 * session_shutdown, so the extension's normal cleanup never runs. Files owned by
 * live tasks in this process are skipped; a task from another Pi process that
 * stays silent for over 24h can still be swept — accepted, since $TMPDIR cleanup
 * would eventually remove it too.
 */
export function sweepOrphanLogs(): void {
  let entries: string[];
  try {
    entries = readdirSync(OUTPUT_DIR);
  } catch {
    return; // No dir yet, or unreadable — nothing to sweep.
  }
  const live = new Set(manager.listAll().map((task) => task.outputPath));
  const cutoff = Date.now() - ORPHAN_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.startsWith("bg_") || !entry.endsWith(".log")) continue;
    const path = join(OUTPUT_DIR, entry);
    if (live.has(path)) continue;
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // A single unreadable/unremovable file must not abort the sweep.
    }
  }
}

/** POSIX single-quote escaping for the wrapper's pid/start files. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The shell writes its own pid and start time before running the user command.
 *  `$$` survives `exec`, so the reaper can verify the pid was not reused. */
function wrapCommand(command: string, pidPath: string, startPath: string, taskId: string): string {
  return [
    `__pi_bg_pid=$$`,
    `printf '%s\\n' "$__pi_bg_pid" > ${shellQuote(pidPath)}`,
    `ps -p "$__pi_bg_pid" -o lstart= > ${shellQuote(startPath)} 2>/dev/null || true`,
    `# pi-bg:${taskId}`,
    command,
  ].join("\n");
}

function cleanupTaskMeta(task: { pidPath: string; startPath: string; journalPath: string }): void {
  rmSync(task.journalPath, { force: true });
  rmSync(task.pidPath, { force: true });
  rmSync(task.startPath, { force: true });
}

interface JournalRecord {
  taskId: string;
  ownerPid: number;
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
  } catch {
    return false;
  }
}

function processStart(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function commandMatches(taskId: string, pid: number): boolean {
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return command.includes(`pi-bg:${taskId}`);
  } catch {
    return false;
  }
}

function killTaskTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
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

function cleanupOrphan(record: Pick<JournalRecord, "taskId" | "journalPath" | "pidPath" | "startPath" | "outputPath">): void {
  rmSync(record.journalPath, { force: true });
  rmSync(record.pidPath, { force: true });
  rmSync(record.startPath, { force: true });
  rmSync(record.outputPath, { force: true });
}

/**
 * Kill tasks left behind by a Pi process that was SIGKILLed or crashed. The
 * owner pid and the task's start time are checked first, so a reused pid is
 * never killed. A task that cannot be verified is left for a later load.
 */
export function reapOrphans(): void {
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
      const parsed = JSON.parse(readFileSync(journalPath, "utf8")) as Partial<JournalRecord>;
      const id = typeof parsed.taskId === "string" ? parsed.taskId : name.slice(0, -".journal.json".length);
      const paths = orphanPaths(id);
      const record: JournalRecord = {
        taskId: id,
        ownerPid: typeof parsed.ownerPid === "number" ? parsed.ownerPid : -1,
        command: typeof parsed.command === "string" ? parsed.command : "",
        outputPath: typeof parsed.outputPath === "string" ? parsed.outputPath : paths.outputPath,
        pidPath: typeof parsed.pidPath === "string" ? parsed.pidPath : paths.pidPath,
        startPath: typeof parsed.startPath === "string" ? parsed.startPath : paths.startPath,
        journalPath,
        startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      };
      if (record.ownerPid > 0 && isProcessAlive(record.ownerPid)) continue;

      let pid = 0;
      try {
        pid = Number(readFileSync(record.pidPath, "utf8").trim());
      } catch {}
      if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
        cleanupOrphan(record);
        continue;
      }

      const recordedStart = (() => {
        try {
          return readFileSync(record.startPath, "utf8").trim();
        } catch {
          return "";
        }
      })();
      const currentStart = processStart(pid);
      const verified =
        (recordedStart !== "" && currentStart !== "" && currentStart === recordedStart) ||
        commandMatches(id, pid);
      if (!verified) {
        // A reused PID or an unreadable start marker: never kill it. Drop the
        // journal only after the grace period so a later load can retry.
        if (record.startedAt > 0 && Date.now() - record.startedAt > ORPHAN_MAX_AGE_MS) cleanupOrphan(record);
        continue;
      }

      killTaskTree(pid);
      cleanupOrphan(record);
    } catch {
      // Corrupt journal or a filesystem race: leave it for the next load.
    }
  }
}

export class BackgroundManager {
  private readonly tasks = new Map<string, InternalTask>();
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
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const id = `bg_${randomBytes(8).toString("hex")}`;
    const outputPath = join(OUTPUT_DIR, `${id}.log`);
    const pidPath = join(OUTPUT_DIR, `${id}.pid`);
    const startPath = join(OUTPUT_DIR, `${id}.start`);
    const journalPath = join(OUTPUT_DIR, `${id}.journal.json`);
    // Create the file synchronously so callers can rely on it existing the moment start() returns;
    // createWriteStream opens asynchronously and would otherwise race the caller.
    writeFileSync(outputPath, "");
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
      done: Promise.resolve(),
      pidPath,
      startPath,
      journalPath,
    };

    // Without this, a write failure (ENOSPC/EACCES on a long-lived task) is an unhandled stream
    // error, which Node promotes to an uncaught exception that takes down the whole Pi process.
    fileStream.on("error", (error) => {
      task.error = `output file write failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    // Output-file cap: a pathological producer (`yes`) can otherwise write tens of GB.
    // Past the cap the file stops growing and a marker line records what was dropped;
    // the task itself keeps running to its exit or explicit timeout.
    let fileBytes = 0;
    let fileCapped = false;

    const ops = options?.operations ?? createLocalBashOperations();
    const outputClosed = finished(fileStream, { cleanup: true }).catch(() => {});
    // The journal lets the next extension load kill a task whose owner Pi was
    // SIGKILLed or crashed (session_shutdown cannot run on those paths).
    writeFileSync(
      journalPath,
      JSON.stringify({
        taskId: id,
        ownerPid: process.pid,
        command,
        outputPath,
        pidPath,
        startPath,
        startedAt: Date.now(),
      }),
    );
    const wrapped = wrapCommand(command, pidPath, startPath, id);
    const execution = ops
      .exec(options?.commandPrefix ? `${options.commandPrefix}\n${wrapped}` : wrapped, cwd, {
        signal: controller.signal,
        env: options?.env,
        // ops.exec owns the explicit lifetime: it kills the process tree and rejects
        // with `timeout:<seconds>`. `undefined` and `0` both mean no timeout.
        timeout: options?.timeoutSeconds && options.timeoutSeconds > 0 ? options.timeoutSeconds : undefined,
        onData: (chunk) => {
          // StringDecoder holds an incomplete multi-byte character until the rest of it arrives,
          // instead of corrupting the preview at chunk boundaries.
          this.appendTail(task, decoder.write(chunk));
          if (fileCapped) return;
          fileBytes += chunk.length;
          if (fileBytes > OUTPUT_FILE_CAP_BYTES) {
            fileCapped = true;
            // ponytail: ignores write() backpressure. Only matters if a chatty command outpaces the
            // disk; add a pause/resume shim if that ever shows up in practice.
            fileStream.write(`\n[output truncated: ${fileBytes - OUTPUT_FILE_CAP_BYTES} bytes dropped, producer kept running]\n`);
            return;
          }
          fileStream.write(chunk);
        },
      })
      .then(({ exitCode }) => {
        task.status = "exited";
        task.exitCode = exitCode;
      })
      .catch((error) => {
        if (error instanceof Error && error.message.startsWith("timeout:")) {
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
        fileStream.end();
        return outputClosed;
      })
      .then(() => {
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

  private maybeNotify(task: InternalTask): void {
    if (task.notified) return;
    if (!task.notifyOnExit) return;
    task.notified = true;
    this.onExit?.(this.toPublic(task));
  }

  async clearSession(parentSessionId: string): Promise<void> {
    const tasks = Array.from(this.tasks.values()).filter((task) => task.parentSessionId === parentSessionId);

    for (const task of tasks) {
      task.notifyOnExit = false;
      if (task.status === "running") task.controller.abort();
      this.tasks.delete(task.id);
    }

    await Promise.all(
      tasks.map(async (task) => {
        // Do not hang Pi forever on a process that refuses to die. If the wait
        // times out, the journal stays and the next-start reaper kills it.
        const settled = await Promise.race([
          task.done.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SHUTDOWN_WAIT_MS)),
        ]);
        if (!settled) return;
        cleanupTaskMeta(task);
        await rm(task.outputPath, { force: true }).catch(() => {});
      }),
    );
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
// A stale install of an older version (e.g. an outdated npm cache) can load first in the same
// process and occupy the symbol with an instance that lacks newer methods, which would crash
// this module at load ("manager.listAll is not a function"). Reuse the global only if it has
// the methods this module needs; otherwise replace it — safe, because extensions all load at
// startup before any task can start. The check is by capability, not instanceof: /reload
// re-evaluates the class, so instances worth keeping are not instanceof this module's class.
const MANAGER_KEY = Symbol.for("@bytetrue/pi-background-terminal.manager");
const globalStore = globalThis as unknown as Record<symbol, BackgroundManager | undefined>;

function isCompatibleManager(instance: BackgroundManager | undefined): instance is BackgroundManager {
  return typeof instance?.listAll === "function";
}

export const manager: BackgroundManager = isCompatibleManager(globalStore[MANAGER_KEY])
  ? globalStore[MANAGER_KEY]
  : (globalStore[MANAGER_KEY] = new BackgroundManager());

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
 * (natural, failed, or an explicit lifetime expiry) wakes the agent with a follow-up.
 *
 * opencode's background shell has no timeout by default and treats an explicit timeout
 * as the only lifetime bound; this tool does the same. Pi's session shutdown is the real
 * cleanup boundary: every task the session started is killed when the session ends, so
 * "no default lifetime" cannot leave a process behind after Pi exits. A timed-out dev
 * server renews by restarting (the wake-up message says so).
 *
 * The exit notification (followUp + triggerTurn) fires exactly once per task.
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
        operations: createLocalBashOperations({ shellPath: cached.settings.shellPath }),
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

  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const binDir = join(agentDir, "bin");
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

      // The task can finish between the get() above and here; report what actually happened.
      if (!manager.kill(params.id, parentSessionId)) {
        const settled = manager.get(params.id, parentSessionId) ?? task;
        return {
          content: [{ type: "text", text: `[${settled.id}] finished on its own (${settled.status}); nothing to stop.` }],
          details: settled,
        };
      }

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
      if (manager.kill(current.id, sessionId)) {
        ctx.ui.notify("Background command stopped.", "info");
      } else {
        ctx.ui.notify("That background command is no longer running.", "warning");
      }
      return;
    }
  }
}

async function showOutput(ctx: ExtensionCommandContext, task: BackgroundTask): Promise<void> {
  let output: string;
  try {
    output = await readFile(task.outputPath, "utf8");
  } catch (error) {
    ctx.ui.notify(`Could not read background output: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  await ctx.ui.editor(`Output — ${truncateLine(task.command.replace(/\s+/g, " ").trim(), 100).text}`, output || "(no output yet)");
}

function formatTaskOption(task: BackgroundTask): string {
  const command = truncateLine(task.command.replace(/\s+/g, " ").trim(), 100).text;
  return `[${task.status}] ${command} — ${task.id}`;
}

// ---------------------------------------------------------------------------
// extension entry point
// ---------------------------------------------------------------------------

export default function registerBackgroundTerminal(pi: ExtensionAPI): void {
  // A SIGKILLed/crashed Pi cannot run session_shutdown; kill the tasks its
  // journal left behind before starting new work. Then sweep stale logs from
  // sessions that predate the journal.
  reapOrphans();
  sweepOrphanLogs();

  let currentSessionId: string | null = null;
  let updateStatus: (() => void) | undefined;
  let agentBusy = false;
  let pendingExits: BackgroundTask[] = [];

  // Pi drains the followUp queue one message at a time by default, so one message per exit
  // would wake the agent into a separate turn per task. Exits that land while the agent is
  // busy are buffered and flushed as a single message when it settles; followUp messages are
  // only delivered once the agent finishes anyway, so this changes no delivery timing.
  const flushPendingExits = () => {
    const batch = pendingExits;
    pendingExits = [];
    const first = batch[0];
    if (!first) return;
    const content =
      batch.length === 1
        ? formatExitMessage(first)
        : `${batch.length} background tasks finished:\n\n${batch.map(formatExitMessage).join("\n\n")}`;
    pi.sendMessage(
      {
        customType: "background-exit",
        content,
        display: true,
        details: batch.length === 1 ? first : batch,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  manager.init(
    (task) => {
      if (!currentSessionId || task.parentSessionId !== currentSessionId) return;
      // followUp + triggerTurn is what makes this hands-off: it wakes an idle agent into a new turn
      // with the outcome, so nothing has to poll background_status to notice completion.
      pendingExits.push(task);
      if (!agentBusy) flushPendingExits();
    },
    () => updateStatus?.(),
  );

  registerBackgroundCommand(pi);
  // No foreground-timeout hook here: the default for bash/powershell lives in the
  // separate bash-timeout extension, so an install of this package contains no hook
  // source at all.
  registerBackgroundRunTool(pi);
  registerBackgroundStatusTool(pi);
  registerBackgroundKillTool(pi);

  pi.on("agent_start", async () => {
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
    const sessionId = ctx.sessionManager.getSessionId();
    currentSessionId = sessionId;
    updateStatus = () => {
      const running = manager.list(sessionId).filter((task) => task.status === "running").length;
      ctx.ui.setStatus("background-terminal", running === 0 ? undefined : `bg:${running}`);
    };
    updateStatus();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // "reload" re-fires session_shutdown/session_start on the SAME session (extensions and config
    // hot-reload), it does not end the session. Background tasks must survive a /reload.
    if (event.reason === "reload") return;

    const sessionId = ctx.sessionManager.getSessionId();
    ctx.ui.setStatus("background-terminal", undefined);
    updateStatus = undefined;
    pendingExits = [];
    if (currentSessionId === sessionId) currentSessionId = null;
    await manager.clearSession(sessionId);
  });
}

function formatExitMessage(task: BackgroundTask): string {
  const state =
    task.status === "exited"
      ? "completed"
      : task.status === "failed"
        ? "failed"
        : task.status === "timed_out"
          ? "timed_out"
          : "killed";
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
  if (task.exitCode !== null) body.push(`Exit code: ${task.exitCode}`);
  body.push(`Full output: ${task.outputPath}`);

  return `<shell id="${escapeAttribute(task.id)}" state="${state}" command="${escapeAttribute(task.command)}">\n${body.join("\n\n")}\n</shell>`;
}

const NOTIFICATION_TAIL_LINES = 50;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Strip terminal control sequences from model-facing output; the raw stream
 * stays in the output file for `read`. */
function stripTerminal(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Bounded tail for the completion notice. The full stream stays in the file. */
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
