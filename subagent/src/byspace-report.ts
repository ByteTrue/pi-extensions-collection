import type { SubagentTaskRecord } from "./index.js";

/**
 * BySpace report bridge (pi first-class adaptation).
 *
 * When BySpace launches a pi agent it injects BYSPACE_SUBAGENT_REPORT_URL and
 * BYSPACE_SUBAGENT_REPORT_TOKEN into the process env. The extension then POSTs a
 * small snapshot per task change so the daemon can track running subagents and
 * locate the child session log (sessionId + cwd) for its timeline tab. The token
 * alone identifies the agent — the daemon minted it per pi launch. Without the
 * env pair (plain pi usage) this module never sends anything.
 */

const REPORT_ENV_URL = "BYSPACE_SUBAGENT_REPORT_URL";
const REPORT_ENV_TOKEN = "BYSPACE_SUBAGENT_REPORT_TOKEN";

// Reload keeps tasks alive, so their in-flight reports must share the same queue.
const PENDING_KEY = Symbol.for("@bytetrue/pi-subagent.byspace-pending");
const pendingGlobal = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const pendingReports = (pendingGlobal[PENDING_KEY] ??= new Map<string, Promise<void>>());

export interface ByspaceReportRecord {
  id: string;
  status: SubagentTaskRecord["status"];
  sessionId?: string;
  cwd?: string;
  /** Absolute path to the child's persisted session jsonl, so the daemon skips its own lookup. */
  sessionFile?: string;
}

function childSession(
  record: SubagentTaskRecord,
  resolveSessionFile:
    | ((run: { sessionId: string; cwd?: string; agentDir?: string }) => string | undefined)
    | undefined,
): { sessionId?: string; cwd?: string; sessionFile?: string } {
  const run = record.progress?.runs[0];
  const sessionId = run?.sessionId ?? record.sessionId;
  if (!sessionId) return {};
  const cwd = run?.cwd ?? record.cwd;
  const sessionFile = resolveSessionFile?.(run ?? { sessionId, cwd });
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

/**
 * resolveSessionFile is injected (index.ts passes sessionLogPath) rather than imported —
 * importing it here would make the index.js dependency a runtime cycle.
 */
export function buildByspaceReportRecord(
  task: SubagentTaskRecord,
  resolveSessionFile?: (run: {
    sessionId: string;
    cwd?: string;
    agentDir?: string;
  }) => string | undefined,
): ByspaceReportRecord {
  return {
    id: task.id,
    status: task.status,
    ...childSession(task, resolveSessionFile),
  };
}

export class ByspaceReporter {
  private readonly url: string | undefined;
  private readonly token: string | undefined;
  /** Last running snapshot sent per task, to skip duplicate progress churn. */
  private readonly lastRunning = new Map<string, string>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const url = env[REPORT_ENV_URL]?.trim();
    const token = env[REPORT_ENV_TOKEN]?.trim();
    this.url = url && token ? url : undefined;
    this.token = url && token ? token : undefined;
  }

  /**
   * Fire-and-forget; reporting must never affect task execution. Running snapshots
   * are deduped (progress churn resends the same shape); terminal snapshots always
   * go out so a lost request can't strand a finished task as running forever.
   */
  report(record: ByspaceReportRecord): void {
    if (!this.url || !this.token) return;
    const key = JSON.stringify(record);
    if (record.status === "running") {
      if (this.lastRunning.get(record.id) === key) return;
      this.lastRunning.set(record.id, key);
    } else {
      this.lastRunning.delete(record.id);
    }
    // Keep a slow running report from arriving after the task has finished.
    const queueKey = JSON.stringify([this.url, this.token, record.id]);
    const previous = pendingReports.get(queueKey);
    const pending = (async () => {
      if (previous) await previous;
      const attempts = record.status === "running" ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await fetch(this.url!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: this.token, observations: [record] }),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error(`BySpace report failed with HTTP ${response.status}`);
          return;
        } catch {
          // Retry only terminal states; running progress remains best-effort.
        }
      }
      // A failed running snapshot must not suppress the next identical attempt.
      if (this.lastRunning.get(record.id) === key) this.lastRunning.delete(record.id);
    })().catch(() => {});
    pendingReports.set(queueKey, pending);
    void pending.then(() => {
      if (pendingReports.get(queueKey) === pending) pendingReports.delete(queueKey);
    });
  }
}
