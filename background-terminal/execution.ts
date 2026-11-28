import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";

export type BackgroundOperations = {
  exec(command: string, cwd: string, options: {
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    onData: (chunk: Buffer) => void | Promise<void>;
  }): Promise<{ exitCode: number | null }>;
};

type KillTree = (pid: number) => Promise<boolean>;
const registryKey = Symbol.for("@bytetrue/pi-background-terminal.executions.v1");

function activeChildren(): Map<number, KillTree> {
  const store = globalThis as unknown as Record<symbol, Map<number, KillTree> | undefined>;
  if (!store[registryKey]) {
    const children = new Map<number, KillTree>();
    store[registryKey] = children;
    process.once("exit", () => {
      for (const [pid, killTree] of children) {
        // Invoke immediately: the supplied helper starts the OS action before its first await.
        try { void killTree(pid).catch(() => {}); } catch {}
      }
    });
  }
  return store[registryKey];
}

function shellEnv(): NodeJS.ProcessEnv {
  const bin = join(getAgentDir(), "bin");
  const key = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = process.env[key] ?? "";
  return { ...process.env, [key]: current.split(delimiter).includes(bin) ? current : [bin, current].filter(Boolean).join(delimiter) };
}

export function createBackgroundBashOperations(killTree: KillTree, shellPath?: string): BackgroundOperations {
  return {
    async exec(command, cwd, { signal, timeout, env, onData }) {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483)) {
        throw new Error("Invalid timeout: must be a finite number of seconds greater than 0 and at most 2147483");
      }
      if (signal?.aborted) throw new Error("aborted");
      const config = getShellConfig(shellPath);
      if (config.commandTransport === "stdin") {
        throw new Error("Background commands do not support WSL-backed shells on native Windows; use Git Bash, MSYS2, or Cygwin Bash.");
      }
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error("Working directory does not exist: " + cwd + "\nCannot execute bash commands.");
      }
      if (signal?.aborted) throw new Error("aborted");
      const child = spawn(config.shell, [...config.args, command], {
        cwd, env: env ?? shellEnv(), detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      const children = activeChildren();
      const registeredKill: KillTree = (pid) => killTree(pid);
      if (child.pid) children.set(child.pid, registeredKill);

      return new Promise((resolve, reject) => {
        const pipes = [child.stdout, child.stderr];
        let exited = false;
        let exitCode: number | null = null;
        let settled = false;
        let blocked = false;
        let outputDone = false;
        let killRequested = false;
        let killing = false;
        let failure: Error | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

        const clearIdle = () => {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        };
        const finish = () => {
          if (settled || !exited || blocked || killing || !outputDone) return;
          settled = true;
          clearIdle();
          clearTimeout(timeoutTimer);
          signal?.removeEventListener("abort", onAbort);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          for (const pipe of pipes) {
            pipe.removeListener("readable", onReadable);
            pipe.removeListener("end", checkOutput);
            pipe.removeListener("error", failOutput);
            pipe.destroy();
          }
          if (failure) reject(failure);
          else resolve({ exitCode: exitCode ?? (child.signalCode ? 128 + (osConstants.signals[child.signalCode] ?? 0) : 1) });
        };
        const checkOutput = () => {
          if (!exited || blocked || settled) return;
          if (pipes.every((pipe) => pipe.readableEnded)) outputDone = true;
          if (outputDone) finish();
          else if (!idleTimer) {
            idleTimer = setTimeout(() => {
              outputDone = true;
              finish();
            }, 100);
          }
        };
        const stop = (error: Error) => {
          failure ??= error;
          if (killRequested || settled || exited) return;
          killRequested = true;
          if (!child.pid) return;
          killing = true;
          const afterKill = () => {
            killing = false;
            // Even a successful request waits for exit; a false/rejected kill cannot fake it.
            finish();
          };
          try { void killTree(child.pid).then(afterKill, afterKill); } catch { afterKill(); }
        };
        const failOutput = (error: unknown) => {
          stop(error instanceof Error ? error : new Error(String(error)));
          outputDone = true;
          clearIdle();
          for (const pipe of pipes) pipe.destroy();
          finish();
        };
        const drain = () => {
          if (blocked || outputDone || settled) return;
          try {
            for (const pipe of pipes) {
              let chunk: Buffer | null;
              while ((chunk = pipe.read()) !== null) {
                clearIdle();
                const pending = onData(chunk);
                if (pending) {
                  blocked = true;
                  for (const pipe of pipes) pipe.pause();
                  void Promise.resolve(pending).then(() => {
                    blocked = false;
                    drain();
                    checkOutput();
                  }, (error) => {
                    blocked = false;
                    failOutput(error);
                  });
                  return;
                }
              }
            }
          } catch (error) {
            failOutput(error);
            return;
          }
          checkOutput();
        };
        // Avoid reentrant Windows pipe reads on libuv < 1.52: https://github.com/libuv/libuv/pull/4784
        const onReadable = () => { setImmediate(drain); };
        const onExit = (code: number | null) => {
          exited = true;
          exitCode = code;
          // Output can outlive the process; its PID must not remain a termination target.
          if (child.pid && children.get(child.pid) === registeredKill) children.delete(child.pid);
          checkOutput();
        };
        const onError = (error: Error) => {
          failure ??= error;
          outputDone = true;
          onExit(null);
        };
        const onAbort = () => stop(new Error("aborted"));

        child.once("error", onError);
        child.once("exit", onExit);
        for (const pipe of pipes) {
          // Read explicitly: Node resumes stdio after child exit, even during a pending sink write.
          pipe.on("readable", onReadable);
          pipe.once("end", checkOutput);
          pipe.on("error", failOutput);
        }
        if (timeout !== undefined) timeoutTimer = setTimeout(() => stop(new Error("timeout:" + timeout)), timeout * 1000);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
}
