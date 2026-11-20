import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const [label, entries, valid] of [
  ["extension entry", ["./example/example.ts"], true],
  ["missing entry", [], false],
  ["missing file", ["./example/missing.ts"], false],
  ["directory entry", ["./example/"], false],
  ["path outside extension", ["./example/../README.md"], false],
  ["backslash traversal", ["./example/..\\README.md"], false],
  ["non-string entry", [null], false],
]) {
  test(label, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-manifest-test-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "example"));
      copyFileSync(new URL("./check-manifest.mjs", import.meta.url), join(root, "scripts", "check-manifest.mjs"));
      writeFileSync(join(root, "README.md"), "fixture");
      writeFileSync(join(root, "example", "package.json"), "{}");
      writeFileSync(join(root, "example", "example.ts"), "export default () => {};");
      writeFileSync(join(root, "package.json"), JSON.stringify({
        workspaces: ["example"], pi: { extensions: entries },
      }));
      const check = () => execFileSync(process.execPath, [join(root, "scripts", "check-manifest.mjs")], { stdio: "pipe" });
      if (valid) assert.match(check().toString(), /manifest OK/);
      else assert.throws(check, (error) => error.status === 1 && /distribution drift detected/.test(error.stderr.toString()));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
