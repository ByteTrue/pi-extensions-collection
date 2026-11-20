import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pendingCompletionIds, registerCompletionSource, type Completion } from "../../shared/completion-delivery.js";

const key = Symbol.for("pi-extensions.completion-delivery");
type State = { sources: Map<string, unknown>; timers: Map<string, ReturnType<typeof setTimeout>> };
const globals = globalThis as unknown as Record<symbol, State>;
const originalState = globals[key]!;
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const state of new Set([globals[key]!, originalState])) {
    for (const timer of state.timers.values()) clearTimeout(timer);
    state.timers.clear();
    state.sources.clear();
  }
  globals[key] = originalState;
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-completion-delivery-")));
  directories.push(path);
  return path;
}

function completion(...ids: string[]): Completion {
  return {
    ids,
    message: { customType: "task-exit", content: ids.join(","), display: true, details: { ids, outputPath: "/retained/output.log" } },
    delivered: vi.fn(),
  };
}

function source(storageDir: string, sessionId: string | null = "parent", id = "shell", send = vi.fn()) {
  const pending: Completion[] = [];
  const runtime = { sessionId, pending, send };
  const delivery = registerCompletionSource(id, {
    storageDir,
    sessionId: () => runtime.sessionId,
    pending: () => pending.slice(),
    send,
  });
  const add = (...ids: string[]) => {
    const item = completion(...ids);
    item.delivered = vi.fn(() => { pending.splice(pending.indexOf(item), 1); });
    pending.push(item);
    return item;
  };
  return { ...runtime, runtime, delivery, add };
}

function recordFiles(storageDir: string): string[] {
  return fs.readdirSync(storageDir).filter((name) => name.endsWith(".json")).map((name) => join(storageDir, name));
}

function record(storageDir: string): string {
  const files = recordFiles(storageDir);
  expect(files).toHaveLength(1);
  return files[0]!;
}

describe("durable shared completion delivery", () => {
  it("restores after losing process-global and source state, including inactive settlement", async () => {
    const storageDir = directory();
    const old = source(storageDir, null);
    const item = completion("one");
    old.delivery.persist("parent", item);
    expect(recordFiles(storageDir)).toHaveLength(1);
    delete globals[key];
    vi.resetModules();
    const freshModule = await import("../../shared/completion-delivery.js");
    const send = vi.fn();
    const fresh = freshModule.registerCompletionSource("shell", { storageDir, sessionId: () => "parent", pending: () => [], send });
    old.delivery.persist("parent", completion("stale"));
    old.runtime.sessionId = "parent";
    old.delivery.flush();
    fresh.flush();
    expect(old.send).not.toHaveBeenCalled();
    expect(send.mock.calls).toEqual([[item.message, { deliverAs: "steer", triggerTurn: true }]]);
    expect(recordFiles(storageDir)).toHaveLength(0);
  });

  it("isolates original parent, source, and profile even when a record is copied", () => {
    const firstDir = directory();
    const secondDir = directory();
    const old = source(firstDir);
    old.delivery.persist("parent", completion("one"));
    const file = record(firstDir);
    const copied = join(secondDir, basename(file));
    fs.copyFileSync(file, copied);
    const otherParent = source(firstDir, "other-parent");
    otherParent.delivery.flush();
    expect(otherParent.send).not.toHaveBeenCalled();
    const otherSource = source(firstDir, "parent", "child");
    otherSource.delivery.flush();
    expect(otherSource.send).not.toHaveBeenCalled();
    const otherProfile = source(secondDir);
    otherProfile.delivery.flush();
    expect(otherProfile.send).not.toHaveBeenCalled();
    expect(recordFiles(firstDir)).toHaveLength(1);
    const restored = source(firstDir);
    restored.delivery.flush();
    expect(restored.send).toHaveBeenCalledTimes(1);
    expect(recordFiles(firstDir)).toHaveLength(0);
    expect(fs.existsSync(copied)).toBe(true);
  });

  it("protects pending IDs for all parents and refuses uncertain cleanup", () => {
    const storageDir = directory();
    const shell = source(storageDir);
    shell.delivery.persist("parent", completion("one"));
    shell.delivery.persist("other-parent", completion("two"));
    source(storageDir, "parent", "child").delivery.persist("parent", completion("three"));
    expect(pendingCompletionIds(storageDir, "shell")).toEqual(new Set(["one", "two"]));
    shell.delivery.flush();
    expect(pendingCompletionIds(storageDir, "shell")).toEqual(new Set(["two"]));
    fs.writeFileSync(record(storageDir), "broken");
    expect(() => pendingCompletionIds(storageDir, "shell")).toThrow();
  });

  it("deduplicates grouped memory, repeated IDs, and disk while batching all sources", () => {
    const storageDir = directory();
    const send = vi.fn();
    const shell = source(storageDir, "parent", "shell", send);
    const child = source(storageDir, "parent", "child", send);
    for (const id of ["one", "two", "three"]) shell.delivery.persist("parent", completion(id));
    child.delivery.persist("parent", completion("one"));
    const grouped = shell.add("one", "two", "one");
    grouped.message.content = "grouped memory card";
    const duplicate = shell.add("two");
    shell.delivery.flush();
    child.delivery.flush();
    expect(send.mock.calls.map(([message]) => message.content)).toEqual(["grouped memory card", "three", "one"]);
    expect(send.mock.calls.map(([, options]) => options.triggerTurn)).toEqual([false, false, true]);
    expect(grouped.delivered).toHaveBeenCalledOnce();
    expect(duplicate.delivered).toHaveBeenCalledOnce();
    expect(shell.pending).toHaveLength(0);
    expect(recordFiles(storageDir)).toHaveLength(0);
  });

  it("rejects partially overlapping opaque groups without losing either task", () => {
    const storageDir = directory();
    const runtime = source(storageDir);
    runtime.add("one", "two");
    runtime.add("two", "three");
    expect(() => runtime.delivery.flush()).toThrow("overlapping completion groups");
    expect(runtime.send).not.toHaveBeenCalled();
    expect(runtime.pending).toHaveLength(2);
  });

  it("removes accepted IDs, retains failed sends, and retries with one continuation", () => {
    const storageDir = directory();
    const send = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("offline"); });
    const shell = source(storageDir, "parent", "shell", send);
    const child = source(storageDir, "parent", "child", send);
    const accepted = shell.add("accepted");
    const failed = child.add("failed");
    shell.delivery.persist("parent", accepted);
    child.delivery.persist("parent", failed);
    shell.delivery.flush();
    expect(accepted.delivered).toHaveBeenCalledOnce();
    expect(failed.delivered).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(record(storageDir), "utf8")).taskId).toBe("failed");
    child.delivery.flush();
    expect(send.mock.calls.map(([message]) => message.content)).toEqual(["accepted", "failed", "failed"]);
    expect(send.mock.calls[2]?.[1]).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(failed.delivered).toHaveBeenCalledOnce();
    expect(recordFiles(storageDir)).toHaveLength(0);
  });

  it("persists each stable ID once and stores only the supplied message and identity", () => {
    const storageDir = join(directory(), "new", "notices");
    const runtime = source(storageDir);
    const item = completion("one");
    runtime.delivery.persist("parent", item);
    const file = record(storageDir);
    const original = fs.readFileSync(file, "utf8");
    item.message.content = "later duplicate";
    runtime.delivery.persist("parent", item);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(storageDir)).toHaveLength(1);
    const stored = JSON.parse(original);
    expect(Object.keys(stored).sort()).toEqual(["message", "profile", "sessionId", "source", "taskId", "version"]);
    expect(stored.message).toEqual(completion("one").message);
    if (process.platform !== "win32") {
      expect(fs.statSync(storageDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["writeFileSync", "fsyncSync", "linkSync"] as const)("propagates %s failures while leaving the in-memory completion deliverable", (operation) => {
    const storageDir = directory();
    const runtime = source(storageDir);
    const item = runtime.add("one");
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    const fail = vi.spyOn(fs, operation).mockImplementation(() => { throw error; });
    syncBuiltinESMExports();
    expect(() => runtime.delivery.persist("parent", item)).toThrow(error);
    expect(fs.readdirSync(storageDir)).toHaveLength(0);
    expect(runtime.pending).toEqual([item]);
    fail.mockRestore();
    syncBuiltinESMExports();
    runtime.delivery.flush(false);
    expect(runtime.send).toHaveBeenCalledWith(item.message, { deliverAs: "steer", triggerTurn: false });
    expect(item.delivered).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a disk removal failure as a successful delivery", () => {
    const storageDir = directory();
    const runtime = source(storageDir);
    const item = runtime.add("one");
    runtime.delivery.persist("parent", item);
    const file = record(storageDir);
    const fail = vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    syncBuiltinESMExports();
    expect(() => runtime.delivery.flush()).toThrow("denied");
    expect(item.delivered).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
    fail.mockRestore();
  });

  it.each(["json", "source", "parent", "profile", "task", "message", "size"])("rejects corrupted or foreign %s records without sending or deleting them", (kind) => {
    const storageDir = directory();
    const runtime = source(storageDir);
    runtime.delivery.persist("parent", completion("one"));
    const file = record(storageDir);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kind === "source") stored.source = "foreign";
    if (kind === "parent") stored.sessionId = "other-parent";
    if (kind === "profile") stored.profile = directory();
    if (kind === "task") stored.taskId = "other-task";
    if (kind === "message") stored.message.content = "x".repeat(50_001);
    const invalid = kind === "json" ? "{broken" : kind === "size" ? "x".repeat(1024 * 1024 + 1) : JSON.stringify(stored);
    fs.writeFileSync(file, invalid);
    expect(() => runtime.delivery.flush()).toThrow();
    expect(() => runtime.delivery.persist("parent", completion("one"))).toThrow();
    expect(runtime.send).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe(invalid);
  });

  it("rejects non-single task writes, oversized content, and oversized replay details", () => {
    const storageDir = directory();
    const runtime = source(storageDir);
    expect(() => runtime.delivery.persist("parent", completion())).toThrow("one stable task ID");
    expect(() => runtime.delivery.persist("parent", completion("one", "two"))).toThrow("one stable task ID");
    const item = completion("one");
    item.message.content = "x".repeat(50_001);
    expect(() => runtime.delivery.persist("parent", item)).toThrow("50000");
    item.message.content = "x".repeat(50_000);
    item.message.details = "x".repeat(1024 * 1024);
    expect(() => runtime.delivery.persist("parent", item)).toThrow("1 MiB");
    item.message.details = {};
    runtime.delivery.persist("parent", item);
    expect(recordFiles(storageDir)).toHaveLength(1);
  });

  it("reports asynchronous restore errors and preserves the rejected record", async () => {
    vi.useFakeTimers();
    const storageDir = directory();
    const runtime = source(storageDir);
    runtime.delivery.persist("parent", completion("one"));
    const file = record(storageDir);
    fs.writeFileSync(file, "broken");
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    runtime.delivery.schedule();
    await vi.advanceTimersByTimeAsync(50);
    expect(report).toHaveBeenCalledWith("Could not deliver completion notices:", expect.any(Error));
    expect(runtime.send).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("broken");
  });

  it("rejects directory symlinks and symlink ancestors without writing through them", () => {
    const root = directory();
    const target = directory();
    const redirect = join(root, "redirect");
    fs.symlinkSync(target, redirect, process.platform === "win32" ? "junction" : "dir");
    for (const storageDir of [redirect, join(redirect, "notices")]) {
      const runtime = source(storageDir);
      expect(() => runtime.delivery.persist("parent", completion("one"))).toThrow("unsafe completion directory");
      expect(() => runtime.delivery.flush()).toThrow("unsafe completion directory");
    }
    expect(fs.readdirSync(target)).toHaveLength(0);
    expect(fs.lstatSync(redirect).isSymbolicLink()).toBe(true);
  });

  it("rejects symlink records without following or deleting them", () => {
    const storageDir = directory();
    const runtime = source(storageDir);
    runtime.delivery.persist("parent", completion("one"));
    const file = record(storageDir);
    const target = directory();
    fs.unlinkSync(file);
    // A junction exercises the same symlink rejection on Windows without elevation.
    fs.symlinkSync(target, file, process.platform === "win32" ? "junction" : "dir");
    expect(() => runtime.delivery.flush()).toThrow("unsafe completion file");
    expect(() => runtime.delivery.persist("parent", completion("one"))).toThrow("unsafe completion file");
    expect(runtime.send).not.toHaveBeenCalled();
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses public directories, public files, and another user's ownership", () => {
    const storageDir = directory();
    const runtime = source(storageDir);
    fs.chmodSync(storageDir, 0o755);
    expect(() => runtime.delivery.persist("parent", completion("one"))).toThrow("private and owned");
    fs.chmodSync(storageDir, 0o700);
    runtime.delivery.persist("parent", completion("one"));
    const file = record(storageDir);
    fs.chmodSync(file, 0o644);
    expect(() => runtime.delivery.flush()).toThrow("private and owned");
    fs.chmodSync(file, 0o600);
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(() => runtime.delivery.persist("parent", completion("one"))).toThrow("private and owned");
    expect(() => runtime.delivery.flush()).toThrow("private and owned");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("rejects stale reload handles and uses the new sender for an existing idle timer", async () => {
    vi.useFakeTimers();
    const storageDir = directory();
    const old = source(storageDir);
    old.delivery.persist("parent", completion("one"));
    old.delivery.schedule();
    const fresh = source(storageDir);
    old.delivery.persist("parent", completion("stale"));
    old.delivery.flush();
    old.delivery.cancel();
    await vi.advanceTimersByTimeAsync(50);
    expect(old.send).not.toHaveBeenCalled();
    expect(fresh.send.mock.calls.map(([message]) => message.content)).toEqual(["one"]);
    expect(recordFiles(storageDir)).toHaveLength(0);
  });

  it("does not send an obsolete source captured before another source reloads it", () => {
    const storageDir = directory();
    let fresh: ReturnType<typeof source>;
    const shell = source(storageDir, "parent", "shell", vi.fn(() => { fresh = source(storageDir, "parent", "child"); }));
    const old = source(storageDir, "parent", "child");
    shell.add("first");
    old.delivery.persist("parent", completion("second"));
    shell.delivery.flush();
    expect(old.send).not.toHaveBeenCalled();
    expect(recordFiles(storageDir)).toHaveLength(1);
    fresh!.delivery.flush();
    expect(fresh!.send).toHaveBeenCalledOnce();
  });

  it("prevents reentrant flushes from resending an unacknowledged card", () => {
    const storageDir = directory();
    const send = vi.fn(() => runtime.delivery.flush());
    const runtime = source(storageDir, "parent", "shell", send);
    runtime.add("one");
    runtime.delivery.persist("parent", completion("one"));
    runtime.delivery.flush();
    expect(send).toHaveBeenCalledOnce();
    expect(recordFiles(storageDir)).toHaveLength(0);
  });

  const [major, minor] = process.versions.node.split(".").map(Number);
  it.skipIf(major! < 22 || (major === 22 && minor! < 18))("survives a real Node process restart", () => {
    const storageDir = directory();
    const helper = new URL("../../shared/completion-delivery.ts", import.meta.url).href;
    const setup = "import { registerCompletionSource } from " + JSON.stringify(helper) + "; const delivery = registerCompletionSource('shell', { storageDir: " + JSON.stringify(storageDir) + ", sessionId: () => 'parent', pending: () => [], send: (message, options) => console.log(JSON.stringify({message, options})) });";
    execFileSync(process.execPath, ["--input-type=module", "-e", setup + "delivery.persist('parent', {ids:['restart'], message:{customType:'task-exit', content:'survived restart', display:true, details:{outputPath:'/kept/output.log'}}, delivered:()=>{}});"], { encoding: "utf8" });
    expect(recordFiles(storageDir)).toHaveLength(1);
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", setup + "delivery.flush(); delivery.flush();"], { encoding: "utf8" }).trim();
    expect(JSON.parse(output)).toEqual({ message: { customType: "task-exit", content: "survived restart", display: true, details: { outputPath: "/kept/output.log" } }, options: { deliverAs: "steer", triggerTurn: true } });
    expect(recordFiles(storageDir)).toHaveLength(0);
  });
});
