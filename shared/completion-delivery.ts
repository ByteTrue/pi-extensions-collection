import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Message = { customType: string; content: string; display: boolean; details?: unknown };
type Send = (message: Message, options: { deliverAs: "steer"; triggerTurn: boolean }) => void;
export type Completion = { ids?: string[]; message: Message; delivered: () => void };
type Source = { storageDir?: string; sessionId: () => string | null; pending: (sessionId: string) => Completion[]; send: Send };
type State = { sources: Map<string, Source>; timers: Map<string, ReturnType<typeof setTimeout>>; flushing?: Set<string> };
type Notice = { version: 1; profile: string; source: string; sessionId: string; taskId: string; message: Message };
const MAX_RECORD_BYTES = 1024 * 1024;

// jiti may evaluate the helper separately for each extension and again on reload.
const key = Symbol.for("pi-extensions.completion-delivery");
const globals = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (globals[key] ??= { sources: new Map(), timers: new Map() });
const flushing = (state.flushing ??= new Set());
const hash = (parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const prefix = (profile: string, id: string, sessionId: string): string => hash([profile, id, sessionId]) + "-";
const filename = (notice: Pick<Notice, "profile" | "source" | "sessionId" | "taskId">): string => prefix(notice.profile, notice.source, notice.sessionId) + hash([notice.profile, notice.source, notice.sessionId, notice.taskId]) + ".json";
const timerKey = (profile: string | undefined, sessionId: string): string => JSON.stringify([profile ?? null, sessionId]);
const current = (id: string, source: Source): boolean => globals[key] === state && state.sources.get(id) === source;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

function assertPrivate(info: Stats, path: string, directory: boolean): void {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error("unsafe completion " + (directory ? "directory: " : "file: ") + path);
  }
  if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) {
    throw new Error("completion path must be private and owned by this user: " + path);
  }
}

// macOS ships /var and /tmp as root-owned symlinks; those are not a redirection of ours.
const systemLink = (info: Stats): boolean => info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o022) === 0;

function storageDirectory(path: string, create: boolean): boolean {
  // Check ancestors before mkdir: a redirected profile must never receive a notice.
  for (let part = path; ; part = dirname(part)) {
    const info = lstatSync(part, { throwIfNoEntry: false });
    if (info && !(info.isDirectory() || (part !== path && systemLink(info)))) throw new Error("unsafe completion directory: " + part);
    if (part === path && info) assertPrivate(info, part, true);
    if (dirname(part) === part) break;
  }
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (!info) return false;
  assertPrivate(info, path, true);
  return true;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function validMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const message = value as Message;
  return validId(message.customType) && typeof message.content === "string" && message.content.length <= 50_000 && typeof message.display === "boolean";
}

function readNotice(path: string, profile: string, id?: string, sessionId?: string): Notice | undefined {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) return undefined;
  assertPrivate(before, path, false);
  if (before.size > MAX_RECORD_BYTES) throw new Error("completion record exceeds 1 MiB: " + path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  let data: string;
  try {
    const info = fstatSync(fd);
    assertPrivate(info, path, false);
    if (info.dev !== before.dev || info.ino !== before.ino) throw new Error("completion file changed while opening: " + path);
    if (info.size > MAX_RECORD_BYTES) throw new Error("completion record exceeds 1 MiB: " + path);
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > info.size) throw new Error("completion record grew while reading: " + path);
    data = bytes.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
  const notice = JSON.parse(data) as Notice | null;
  if (!notice || notice.version !== 1 || notice.profile !== profile || !validId(notice.source) || !validId(notice.sessionId) || (id !== undefined && notice.source !== id) || (sessionId !== undefined && notice.sessionId !== sessionId) || !validId(notice.taskId) || !validMessage(notice.message) || join(profile, filename(notice)) !== path) {
    throw new Error("invalid completion record identity or message: " + path);
  }
  return notice;
}

function persist(id: string, source: Source, sessionId: string, completion: Completion): void {
  const profile = source.storageDir;
  if (!profile) return;
  if (!validId(sessionId) || completion.ids?.length !== 1 || !validId(completion.ids[0]) || !validMessage(completion.message)) {
    throw new Error("persist requires one stable task ID, a parent session, and a message of at most 50000 characters");
  }
  const { customType, content, display, details } = completion.message;
  const notice: Notice = { version: 1, profile, source: id, sessionId, taskId: completion.ids[0], message: { customType, content, display, details } };
  const data = JSON.stringify(notice);
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error("completion record exceeds 1 MiB");
  storageDirectory(profile, true);
  const path = join(profile, filename(notice));
  if (readNotice(path, profile, id, sessionId)) return;
  const temporary = join(profile, "." + randomUUID() + ".tmp");
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let created: Stats | undefined;
  try {
    try {
      created = fstatSync(fd);
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    storageDirectory(profile, false);
    // Publish without replacing an existing record, including a concurrent persist.
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readNotice(path, profile, id, sessionId)) throw error;
    }
  } finally {
    if (created) {
      const info = lstatSync(temporary);
      assertPrivate(info, temporary, false);
      if (info.dev !== created.dev || info.ino !== created.ino) throw new Error("completion temporary file changed: " + temporary);
      unlinkSync(temporary);
    }
  }
}

function restore(id: string, source: Source, sessionId: string): Notice[] {
  const profile = source.storageDir;
  if (!profile || !storageDirectory(profile, false)) return [];
  const start = prefix(profile, id, sessionId);
  return readdirSync(profile).filter((name) => name.startsWith(start) && name.endsWith(".json")).flatMap((name) => {
    const notice = readNotice(join(profile, name), profile, id, sessionId);
    return notice ? [notice] : [];
  });
}

/** All parents are included so cleanup cannot delete another session's pending output. */
export function pendingCompletionIds(storageDir: string, sourceId: string): Set<string> {
  const profile = resolve(storageDir);
  const ids = new Set<string>();
  if (!storageDirectory(profile, false)) return ids;
  for (const name of readdirSync(profile)) {
    if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue;
    const notice = readNotice(join(profile, name), profile);
    if (notice?.source === sourceId) ids.add(notice.taskId);
  }
  return ids;
}

function acknowledge(id: string, source: Source, sessionId: string, ids: string[]): void {
  const profile = source.storageDir;
  if (!profile || !storageDirectory(profile, false)) return;
  for (const taskId of ids) {
    const path = join(profile, filename({ profile, source: id, sessionId, taskId }));
    if (!readNotice(path, profile, id, sessionId)) continue;
    try {
      unlinkSync(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

function cancel(profile: string | undefined, sessionId: string): void {
  const timerId = timerKey(profile, sessionId);
  clearTimeout(state.timers.get(timerId));
  state.timers.delete(timerId);
}

function flush(profile: string | undefined, sessionId: string, triggerTurn: boolean): void {
  if (globals[key] !== state) return;
  cancel(profile, sessionId);
  const timerId = timerKey(profile, sessionId);
  if (flushing.has(timerId)) return;
  flushing.add(timerId);
  try {
    const batch: { id: string; source: Source; completion: Completion; ids: string[]; callbacks: (() => void)[] }[] = [];
    for (const [id, source] of state.sources) {
      if (source.storageDir !== profile || source.sessionId() !== sessionId) continue;
      const covered = new Map<string, (typeof batch)[number]>();
      for (const completion of source.pending(sessionId)) {
        const ids = [...new Set(completion.ids ?? [])];
        if (completion.ids && (ids.length === 0 || ids.some((taskId) => !validId(taskId)))) throw new Error("completion requires stable task IDs");
        const previous = ids.map((taskId) => covered.get(taskId));
        if (previous.some(Boolean)) {
          const first = previous[0];
          if (!first || previous.some((entry) => entry !== first)) throw new Error("overlapping completion groups cannot be delivered safely");
          first.callbacks.push(completion.delivered);
          continue;
        }
        const entry = { id, source, completion, ids, callbacks: [completion.delivered] };
        batch.push(entry);
        for (const taskId of ids) covered.set(taskId, entry);
      }
      for (const notice of restore(id, source, sessionId)) {
        if (covered.has(notice.taskId)) continue;
        const entry = { id, source, completion: { message: notice.message, delivered: () => {} }, ids: [notice.taskId], callbacks: [] };
        batch.push(entry);
        covered.set(notice.taskId, entry);
      }
    }
    for (let index = 0; index < batch.length; index++) {
      const { id, source, completion, ids, callbacks } = batch[index]!;
      if (!current(id, source) || source.sessionId() !== sessionId) return;
      try {
        // Preserve source-specific cards/replay data, but request only one model continuation.
        source.send(completion.message, { deliverAs: "steer", triggerTurn: triggerTurn && index === batch.length - 1 });
      } catch {
        return;
      }
      // shortcut: void sendMessage has no durable receipt; a crash/async failure can replay or lose this handoff.
      acknowledge(id, source, sessionId, ids);
      for (const delivered of new Set(callbacks)) delivered();
    }
  } finally {
    flushing.delete(timerId);
  }
}

export function registerCompletionSource(id: string, source: Source) {
  if (!validId(id)) throw new Error("completion source requires a stable ID");
  if (source.storageDir !== undefined) {
    if (!source.storageDir) throw new Error("completion storage directory must not be empty");
    source = { ...source, storageDir: resolve(source.storageDir) };
  }
  state.sources.set(id, source);
  return {
    persist(sessionId: string, completion: Completion): void {
      if (!current(id, source)) return;
      persist(id, source, sessionId, completion);
    },
    flush(triggerTurn = true): void {
      const sessionId = source.sessionId();
      if (sessionId && current(id, source)) flush(source.storageDir, sessionId, triggerTurn);
    },
    schedule(): void {
      const sessionId = source.sessionId();
      const timerId = sessionId ? timerKey(source.storageDir, sessionId) : "";
      if (!sessionId || !current(id, source) || state.timers.has(timerId)) return;
      // Nearby idle completions share a wake-up; busy completions flush at turn_end.
      const timer = setTimeout(() => {
        try {
          flush(source.storageDir, sessionId, true);
        } catch (error) {
          console.error("Could not deliver completion notices:", error);
        }
      }, 50);
      timer.unref?.();
      state.timers.set(timerId, timer);
    },
    cancel(): void {
      const sessionId = source.sessionId();
      if (sessionId && current(id, source)) cancel(source.storageDir, sessionId);
    },
  };
}
