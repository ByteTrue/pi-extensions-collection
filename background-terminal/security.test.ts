import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reapOrphans } from "./background-terminal.js";

const DIR = join(tmpdir(), "background-terminal");
const created: string[] = [];

function track(path: string): string {
  created.push(path);
  return path;
}

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { force: true, recursive: true });
  if (existsSync(DIR)) chmodSync(DIR, 0o700);
});

describe("background state directory boundary", () => {
  it("does not follow journal paths outside the state directory", () => {
    mkdirSync(DIR, { recursive: true });
    const id = "bg_deadbeefdeadbeef";
    const journalPath = track(join(DIR, `${id}.journal.json`));
    const outputPath = track(join(tmpdir(), `background-outside-output-${process.pid}`));
    const pidPath = track(join(tmpdir(), `background-outside-pid-${process.pid}`));
    const startPath = track(join(tmpdir(), `background-outside-start-${process.pid}`));
    for (const path of [outputPath, pidPath, startPath]) writeFileSync(path, "do not delete");
    writeFileSync(journalPath, JSON.stringify({
      taskId: id,
      ownerPid: 999_999,
      outputPath,
      pidPath,
      startPath,
      startedAt: Date.now(),
    }));

    reapOrphans();

    for (const path of [outputPath, pidPath, startPath]) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("do not delete");
    }
  });

  it("tightens an owned loose directory before using it", () => {
    mkdirSync(DIR, { recursive: true });
    chmodSync(DIR, 0o755);

    reapOrphans();

    expect(statSync(DIR).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("refuses a directory owned by another user", () => {
    mkdirSync(DIR, { recursive: true });
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(statSync(DIR).uid + 1);
    try {
      expect(() => reapOrphans()).toThrow(/owned by another user/);
    } finally {
      getuid.mockRestore();
    }
  });
});
