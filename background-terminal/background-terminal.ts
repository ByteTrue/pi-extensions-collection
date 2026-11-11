import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * Default and hard cap for the built-in shell tools' timeout parameter, in seconds.
 * Kept here because background_run's lifetime guard reads it (BYTE-7): "was a usable
 * timeout passed?" must mean the same thing on every shell surface this package owns.
 *
 * The foreground inject-and-clamp hook that also used to live in this package moved to
 * the separate small-extensions/bash-timeout extension (BYTE-10, GitHub #3): installed
 * source must be able to contain no foreground-timeout hook at all, which a runtime
 * switch inside this package cannot offer. This constant and the guard below are pure
 * helpers — no hook code remains here.
 */
export const SHELL_TIMEOUT_SECONDS = 300;

/**
 * A usable timeout: finite, positive, a real number. Anything else counts as absent.
 * Note: `0` is treated as absent on purpose — Node convention reads it as "infinite",
 * and an unbounded foreground command is exactly what an unbounded background task
 * would be, too. The small-extensions/bash-timeout extension carries its own copy of
 * this guard (packages and extensions in this repo never depend on each other) so both
 * surfaces keep answering "was a timeout actually passed?" with the same semantics.
 */
export function isUsableTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

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
  /** Hard lifetime cap in seconds, when one was set. */
  timeoutSeconds?: number;
  error?: string;
}

interface InternalTask extends BackgroundTask {
  controller: AbortController;
  notifyOnExit: boolean;
  notified: boolean;
  done: Promise<void>;
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
/** Orphan logs older than this are swept at extension load. $TMPDIR is OS-cleaned eventually; this only bounds the gap. */
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
      timeoutSeconds: options?.timeoutSeconds,
      controller,
      notifyOnExit: true,
      notified: false,
      done: Promise.resolve(),
    };

    // Without this, a write failure (ENOSPC/EACCES on a long-lived task) is an unhandled stream
    // error, which Node promotes to an uncaught exception that takes down the whole Pi process.
    fileStream.on("error", (error) => {
      task.error = `output file write failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    // Output-file cap: a pathological producer (`yes`) running for the full 600s default
    // lifetime would otherwise write tens of GB. Past the cap the file stops growing and a
    // marker line records what was dropped; the task itself keeps running to its exit.
    let fileBytes = 0;
    let fileCapped = false;

    const ops = options?.operations ?? createLocalBashOperations();
    const outputClosed = finished(fileStream, { cleanup: true }).catch(() => {});
    const execution = ops
      .exec(options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command, cwd, {
        signal: controller.signal,
        env: options?.env,
        // ops.exec owns the hard-kill timeout: it kills the process tree and rejects with
        // `timeout:<seconds>` — the same mechanism the built-in bash tool relies on.
        timeout: options?.timeoutSeconds,
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
    task.notifyOnExit = false;
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
        await task.done;
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
    task.tail = (task.tail + chunk).slice(-TAIL_PREVIEW_CHARS);
  }

  private toPublic(task: InternalTask): BackgroundTask {
    const { controller: _controller, notifyOnExit: _notifyOnExit, notified: _notified, done: _done, ...publicTask } = task;
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
// background_run
// ---------------------------------------------------------------------------

/** Default total lifetime: hard-kill bound for a background task with no explicit timeout. */
const DEFAULT_LIFETIME_SECONDS = 600;

/**
 * Hard cap on a background task's total lifetime, explicit timeout included (seconds).
 * Rationale: background tasks are cleared on session_shutdown, so no task outlives its
 * session anyway — the cap bounds how long a *zombie* task may burn resources inside a
 * live session. It also bounds the renew loop: a dev server started with the cap must be
 * restarted (and its consumers reconnected) every time it fires, and that reconnect cost
 * is real work — 3600s fired inside a single working session and cost more than the
 * zombie ceiling it bought (2026-10-01 用户口径). 8 hours spans any working session —
 * the cap now fires only for genuinely forgotten tasks; the ceiling itself
 * stays (0.8.x taught 86400 for dev servers, which is 不设上限 in practice — see ff 099).
 */
const HARD_CAP_LIFETIME_SECONDS = 28_800;

/**
 * `background_run` — a pure background executor. It never waits, never returns command
 * output inline; it starts the command and returns a task id immediately. The exit
 * (natural, failed, or timed-out) wakes the agent with a follow-up.
 *
 * The selection axis against the built-in bash is "do you need the result now":
 * the model knows this before calling — no duration prediction involved. bash is the
 * foreground executor (native, untouched); background_run is for anything that should
 * run hands-off: builds, test suites, dev servers, watch modes.
 *
 * Dual inheritance from the 077/078 work, minus the wait path:
 * - timeout defaults to 600s total lifetime; explicit values are honored up to the
 *   hard cap (`HARD_CAP_LIFETIME_SECONDS`), above which they are clamped — and a timed-out
 *   dev server renews by restarting (the wake-up message says so);
 * - the exit notification (followUp + triggerTurn) fires exactly once per task.
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
    description: `Starts a shell command in the background and returns immediately with a task id; the command keeps running on its own. Use it for work that should run hands-off — builds, test suites, dev servers, watch mode. When you need the output to decide your next step, use bash instead. After it starts, continue with other work or end your turn: its exit — natural, failed, or timed-out — arrives as a new message that starts your next turn. That notification is how you wait. The command is hard-killed after timeout seconds (default ${DEFAULT_LIFETIME_SECONDS}, hard cap ${HARD_CAP_LIFETIME_SECONDS} — larger values are clamped). A dev server that hits the cap is renewed by restarting it with background_run; the timeout notification tells you when. Full output streams to a file (path in the result); use read on that path.`,
    promptSnippet: `Start a command in the background; its exit arrives later as a new message. Use bash when you need the result now.`,
    // Positive-first wording (decision 001): each line says what to do; the wait model is stated
    // explicitly because a bare "do not poll" left a vacuum the model filled with `sleep`.
    promptGuidelines: [
      "Use background_run for work that should run hands-off — builds, test suites, dev servers, watch mode — anything you can leave running while you do other things",
      "When you need a command's output to decide your next step, use bash — it blocks and returns the output",
      "After background_run returns, the command is already running: continue with other work or end your turn. Its exit arrives as a new message that starts your next turn — that notification is how you wait. background_status is for a one-off look at partial output",
      `timeout is a hard lifetime cap (default ${DEFAULT_LIFETIME_SECONDS}s, hard cap ${HARD_CAP_LIFETIME_SECONDS}s — larger values are clamped); pass a larger value for dev servers and watch modes, and restart with background_run when the timeout notification arrives to renew them`,
      `Pi caps bash/powershell foreground calls at ${SHELL_TIMEOUT_SECONDS}s only when the optional bash-timeout extension is installed (it injects the default and caps explicit values); when a command needs longer, run it with background_run and a larger timeout instead of blocking on bash`,
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, description: "The shell command to run in the background" }),
      timeout: Type.Optional(
        Type.Number({
          minimum: 0.001,
          maximum: 2147483,
          description: `Hard lifetime cap in seconds. Defaults to ${DEFAULT_LIFETIME_SECONDS}; clamped to ${HARD_CAP_LIFETIME_SECONDS} — restart with background_run on the timeout notification to renew long-running services. Non-positive or non-finite values are treated as absent and fall back to the default.`,
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
      // Degenerate timeouts (0, negatives, NaN, ±Infinity) count as absent — same semantics
      // as isUsableTimeout. A bare `?? DEFAULT` would leak them through:
      // 0 reaching ops.exec risks meaning "never time out", the exact opposite of this tool's
      // hard lifetime cap, and non-finite values pass no meaningful bound either.
      const timeoutSeconds = Math.min(
        isUsableTimeout(params.timeout) ? params.timeout : DEFAULT_LIFETIME_SECONDS,
        HARD_CAP_LIFETIME_SECONDS,
      );
      const task = manager.start(params.command, ctx.cwd, ctx.sessionManager.getSessionId(), {
        timeoutSeconds,
        operations: createLocalBashOperations({ shellPath: cached.settings.shellPath }),
        env: sessionEnv(ctx),
        commandPrefix: cached.settings.commandPrefix,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started in background: ${task.id}\nOutput file: ${task.outputPath}\nHard timeout: ${timeoutSeconds}s. Its exit will arrive as a new message — continue with other work or end your turn now. Until then the output file is partial.`,
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
            ? `Output so far (still running):\n${task.tail}`
            : "(no output yet, still running)"
          : task.tail
            ? `Recent output:\n${task.tail}`
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
  // Crash paths (uncaughtException, terminal EIO) never fire session_shutdown, so logs
  // from those sessions survive on disk. Sweep stale ones on every load (startup + /reload).
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
        : `${batch.length} background tasks finished:\n${batch.map(formatExitMessage).join("\n")}`;
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
  // No foreground-timeout hook here: the inject-and-clamp for bash/powershell lives in
  // the separate small-extensions/bash-timeout extension (BYTE-10, GitHub #3) so an
  // install of this package contains no hook source at all. background_run still keys
  // its lifetime guard on the shared SHELL_TIMEOUT_SECONDS constants below.
  registerBackgroundRunTool(pi);
  registerBackgroundStatusTool(pi);
  registerBackgroundKillTool(pi);

  pi.on("agent_start", async () => {
    agentBusy = true;
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
  const outcome =
    task.status === "killed"
      ? "was stopped"
      : task.status === "timed_out"
        ? `timed out after ${task.timeoutSeconds} seconds (restart with background_run to renew it)`
        : task.status === "failed"
          ? `failed: ${task.error ?? "unknown error"}`
          : `exited with code ${task.exitCode}`;
  const lastLine = task.tail.trim().split("\n").at(-1);
  const summary = lastLine ? ` Last line: ${truncateLine(lastLine, 250).text}` : "";
  return `[${task.id}] ${task.command} ${outcome}.${summary} Output: ${task.outputPath}`;
}
