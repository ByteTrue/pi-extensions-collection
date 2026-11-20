#!/usr/bin/env node
// Distribution gate.
//
// The root package.json `pi.extensions` list is how every extension reaches a
// machine: Pi reads it from the installed package. An extension missing from the
// list never loads, and nothing reports it. Fails when a directory with its own
// package.json has no manifest entry, when the manifest lists a file that does not
// exist, when an entry lives outside an extension directory, or when the workspace
// list and the extension directories drift apart.
//
// Runs in CI (ci.yml) and locally: node scripts/check-manifest.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const manifest = rootPackage.pi?.extensions;
const workspaces = Array.isArray(rootPackage.workspaces) ? [...rootPackage.workspaces].sort() : [];

const dirs = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
  .filter((entry) => existsSync(join(repoRoot, entry.name, "package.json")))
  .map((entry) => entry.name)
  .sort();

const errors = [];
if (!Array.isArray(manifest) || manifest.length === 0) {
  errors.push("root package.json has no pi.extensions list");
} else {
  for (const name of dirs) {
    if (!manifest.some((entry) => typeof entry === "string" && entry.startsWith(`./${name}/`))) {
      errors.push(`manifest has no entry for ${name}`);
    }
  }
  for (const entry of manifest) {
    if (typeof entry !== "string") {
      errors.push("manifest entries must be file paths");
      continue;
    }
    const normalized = posix.normalize(entry);
    const dir = normalized.split("/")[0];
    if (entry.includes("\\") || entry !== `./${normalized}` || !dirs.includes(dir)) {
      errors.push(`manifest entry ${entry} is not inside an extension directory`);
    }
    const path = join(repoRoot, entry);
    if (!existsSync(path) || !statSync(path).isFile()) {
      errors.push(`manifest lists ${entry}, which is not a file`);
    }
  }
}
if (workspaces.join("\n") !== dirs.join("\n")) {
  errors.push(`workspaces [${workspaces.join(", ")}] do not match extension directories [${dirs.join(", ")}]`);
}

if (errors.length > 0) {
  console.error("distribution drift detected:");
  for (const error of errors) console.error(`  - ${error}`);
  console.error("Update pi.extensions and workspaces in the root package.json.");
  process.exit(1);
}
console.log(`manifest OK (${dirs.length} extensions): ${dirs.join(", ")}`);
