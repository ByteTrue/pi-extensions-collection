import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundManager, type BackgroundTask } from "./background-terminal.js";
import { createBackgroundBashOperations } from "./execution.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});
import { createWriteStream } from "node:fs";

const managers: BackgroundManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.clearSession("pressure");
  vi.restoreAllMocks();
  vi.mocked(createWriteStream).mockReset();
});

async function slowOutput(fail = false) {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let peak = 0;
  let drains = 0;
  let stream: fs.WriteStream | undefined;
  vi.mocked(createWriteStream).mockImplementationOnce((path, options) => {
    stream = actual.createWriteStream(path, {
      ...(typeof options === "object" ? options : {}),
      highWaterMark: 1024,
      fs: {
        open: actual.open,
        close: actual.close,
        write: (fd, buffer, offset, length, position, callback) => {
          setTimeout(() => {
            if (fail) callback(Object.assign(new Error("ENOSPC: slow sink failed"), { code: "ENOSPC" }), 0, buffer);
            else actual.write(fd, buffer, offset, length, position, callback);
          }, 5);
        },
      },
    });
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation((...args: Parameters<fs.WriteStream["write"]>) => {
      const ready = write(...args);
      peak = Math.max(peak, stream!.writableLength);
      return ready;
    });
    stream.on("drain", () => { drains++; });
    return stream;
  });
  const manager = new BackgroundManager();
  managers.push(manager);
  const exits: BackgroundTask[] = [];
  manager.init((task) => exits.push(task));
  return { manager, exits, metrics: () => ({ peak, drains, closed: stream?.closed }) };
}

describe("background output backpressure", () => {
  it("does not retain or signal an exited child PID while its last write is pending", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 2_000_000_100, stdout: new PassThrough(), stderr: new PassThrough(), signalCode: null,
    });
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => { spawned = resolve; });
    vi.mocked(spawn).mockImplementationOnce(() => { spawned(); return child as unknown as ChildProcess; });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const killTree = vi.fn(async () => true);
    const controller = new AbortController();
    const result = createBackgroundBashOperations(killTree).exec("controlled", process.cwd(), {
      signal: controller.signal, onData: () => blocked,
    }).catch((error: Error) => error);
    try {
      await started;
      child.stdout.write("pending disk write");
      await new Promise<void>((resolve) => setImmediate(resolve));
      child.emit("exit", 0, null);
      child.stdout.end();
      child.stderr.end();
      const registry = (globalThis as unknown as Record<symbol, Map<number, unknown>>)[Symbol.for("@bytetrue/pi-background-terminal.executions.v1")];
      expect(registry?.has(child.pid)).toBe(false);
      controller.abort();
      expect(killTree).not.toHaveBeenCalled();
    } finally {
      release();
      await result;
    }
  });

  it("bounds queued log bytes on a slow sink while preserving both output streams", async () => {
    const { manager, exits, metrics } = await slowOutput();
    const task = manager.start(
      'node -e "for (let i=0;i<64;i++) { process.stdout.write(Buffer.alloc(32768,111)); process.stderr.write(Buffer.alloc(32768,101)); }"',
      process.cwd(), "pressure",
    );
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 15_000 });
    const bytes = fs.readFileSync(task.outputPath);
    expect(exits[0]).toMatchObject({ status: "exited", exitCode: 0 });
    expect(bytes.length).toBe(4 * 1024 * 1024);
    expect(bytes.filter((value) => value === 111).length).toBe(2 * 1024 * 1024);
    expect(bytes.filter((value) => value === 101).length).toBe(2 * 1024 * 1024);
    expect(metrics().drains).toBeGreaterThan(1);
    expect(metrics().peak).toBeLessThanOrEqual(256 * 1024);
    expect(metrics().closed).toBe(true);
  }, 20_000);

  it("settles once and stops the producer when a blocked log write fails", async () => {
    const { manager, exits, metrics } = await slowOutput(true);
    manager.start('node -e "process.stdout.write(Buffer.alloc(65536)); setInterval(() => {},1000)"', process.cwd(), "pressure");
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 8000 });
    expect(exits[0]).toMatchObject({ status: "failed", error: expect.stringContaining("slow sink failed") });
    expect(metrics().closed).toBe(true);
  }, 10_000);
});
