#!/usr/bin/env node
// Install-channel gate.
//
// install.mjs is how these extensions reach a user's machine; an extension missing from
// its EXTENSIONS list can never be installed by the documented command, and the failure
// is silent. Fails when a pi-*/ directory is not in the installer's list, or the
// installer lists a source file that does not exist.
//
// Runs in CI (ci.yml) and locally: node scripts/check-installer.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const installer = readFileSync(join(repoRoot, 'install.mjs'), 'utf8');

const names = readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('pi-'))
  .map((entry) => entry.name)
  .sort();

const errors = [];
for (const name of names) {
  if (!installer.includes(`'${name}/`)) {
    errors.push(`installer does not list extension ${name}`);
  }
}
for (const [, source] of installer.matchAll(/'(pi-[^']+\.(?:ts|md|mjs|js))'/g)) {
  if (!existsSync(join(repoRoot, source))) errors.push(`installer lists ${source}, which does not exist`);
}

if (errors.length > 0) {
  console.error('install-channel drift detected:');
  for (const error of errors) console.error(`  - ${error}`);
  console.error('Update the EXTENSIONS list in install.mjs.');
  process.exit(1);
}
console.log(`installer OK (${names.length} extensions): ${names.join(', ')}`);
