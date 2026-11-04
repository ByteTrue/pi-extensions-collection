#!/usr/bin/env node
// Install the drop-in extensions of this repo (pi-extensions-collection) into the
// local Pi extensions directory (~/.pi/agent/extensions/).
//
//   node install.mjs          arrow-key picker (needs a terminal)
//   node install.mjs --all    install every extension, no prompt
//
// Idempotent: re-running overwrites in place - that IS the update path. No cache
// and no ref pinning: the files always come from the repo's main branch on GitHub raw.
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

const REPO_RAW = 'https://raw.githubusercontent.com/ByteTrue/pi-extensions-collection/main';
const EXTENSIONS_DIR = join(homedir(), '.pi', 'agent', 'extensions');

// Pi refuses to start when two extensions register the same tool name ("Tool "ctx_reduce"
// conflicts with ..."), and the second extension's whole load fails. So an extension
// whose tool names another installed package already provides is skipped, not installed.
const TOOL_CONFLICTS = [
  { entry: 'pi-context-guard', providedBy: 'pi-magic-context', tools: 'ctx_reduce / ctx_search / ctx_expand' },
];

// One entry per installable extension: the repo-relative source file (its base name
// is the file name it keeps under EXTENSIONS_DIR) and the label shown in the picker.
// Adding an extension is one line here; scripts/check-installer.mjs fails when a
// pi-*/ directory never made it into this list.
//
// Every entry starts ticked: plain <enter> installs all of them, space is how you
// drop the ones a machine does not want.
const EXTENSIONS = [
  { source: 'pi-bash-timeout/pi-bash-timeout.ts', summary: '300s default + cap for the built-in bash / powershell tools' },
  { source: 'pi-background-terminal/pi-background-terminal.ts', summary: 'background_run / background_status / background_kill tools + the /background menu' },
  { source: 'pi-ask-user/pi-ask-user.ts', summary: 'minimal ask_user tool: 1-4 single/multi-select questions with back-navigation' },
  { source: 'pi-goal/pi-goal.ts', summary: 'minimal /goal: one objective per session, auto-continued until goal_done' },
  { source: 'pi-context-guard/pi-context-guard.ts', summary: 'compact at 400k, session file in prompt, deterministic tool-result pruning + ctx_reduce/search/expand' },
  {
    source: 'pi-vendor/pi-vendor.ts',
    summary: '/vendor TUI + /vendor-ai prompt: manage providers and models in Pi models.json',
    resources: [
      { source: 'pi-vendor/scripts/vendor.mjs', destination: 'pi-vendor/scripts/vendor.mjs' },
      { source: 'pi-vendor/scripts/vendor-shared.js', destination: 'pi-vendor/scripts/vendor-shared.js' },
    ],
  },
];

const ERASE_LINE = '\x1b[2K';

function usage(stream) {
  stream.write('usage: install.mjs [--all]\n');
  stream.write('  no arguments  pick extensions from an arrow-key menu (needs a terminal)\n');
  stream.write('  --all         install every extension without prompting\n');
}

// Arrow-key multi-select. Resolves with the chosen entries, or null when cancelled
// (esc / ctrl-c). Everything starts ticked, so plain <enter> installs the full set.
function pick(items) {
  let index = 0;
  const selected = items.map(() => true);
  let drawn = 0;

  const frame = () => {
    // Truncate to the terminal width so a line never wraps: the redraw counts lines.
    // Unknown width (0/undefined, e.g. a pty with no size) disables truncation.
    const width = process.stdout.columns > 0 ? process.stdout.columns - 1 : Infinity;
    return [
      'Select the extensions to install:',
      ...items.map((item, i) => `${i === index ? '❯' : ' '} ${selected[i] ? '◉' : '○'} ${basename(item.source, '.ts')}  ${item.summary}`),
      '↑/↓ move · space toggle · a all · enter install · esc cancel',
    ].map((line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line));
  };

  const draw = (lines) => {
    let out = drawn > 0 ? `\x1b[${drawn}A` : '';
    for (const line of lines) out += `${ERASE_LINE}${line}\n`;
    drawn = lines.length;
    process.stdout.write(out);
  };

  return new Promise((resolve) => {
    const done = (result) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`\x1b[${drawn}A\x1b[0J\x1b[?25h`);
      resolve(result);
    };

    const onKey = (_str, key) => {
      if (key.ctrl && key.name === 'c') return done(null);
      switch (key.name) {
        case 'up':
        case 'k':
          index = (index - 1 + items.length) % items.length;
          break;
        case 'down':
        case 'j':
          index = (index + 1) % items.length;
          break;
        case 'space':
          selected[index] = !selected[index];
          break;
        case 'a':
          selected.fill(!selected.every(Boolean));
          break;
        case 'return':
        case 'enter':
          return done(items.filter((_item, i) => selected[i]));
        case 'escape':
          return done(null);
        default:
          return;
      }
      draw(frame());
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    process.stdout.write('\x1b[?25l');
    draw(frame());
  });
}

async function installFile(source, dest) {
  const tmp = `${dest}.tmp`;
  try {
    const res = await fetch(`${REPO_RAW}/${source}`);
    if (!res.ok) throw new Error(`GET ${REPO_RAW}/${source} failed with HTTP ${res.status}`);
    // Write beside the destination and rename: a half-written download never becomes
    // a loadable resource (rename is the atomic last step).
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(tmp, await res.text());
    await fs.rename(tmp, dest);
  } finally {
    await fs.rm(tmp, { force: true });
  }
  console.log(`Installed ${basename(source)} → ${dest}`);
}

/** Settings text of the user and the current project, concatenated: whatever is
 * installed by path here is what Pi will load. */
function settingsText() {
  let text = '';
  for (const file of [join(homedir(), '.pi', 'agent', 'settings.json'), join(process.cwd(), '.pi', 'settings.json')]) {
    try {
      text += readFileSync(file, 'utf8');
    } catch {
      // no settings file there
    }
  }
  return text;
}

async function install(entry) {
  const conflict = TOOL_CONFLICTS.find((c) => entry.source.startsWith(`${c.entry}/`) && settingsText().includes(c.providedBy));
  if (conflict) {
    console.log(
      `Skipped ${conflict.entry}: it registers ${conflict.tools}, which ${conflict.providedBy} already provides. ` +
        `Pi will not start with both, so remove one of them first.`,
    );
    return;
  }
  await installFile(entry.source, join(EXTENSIONS_DIR, basename(entry.source)));
  for (const resource of entry.resources ?? []) {
    await installFile(resource.source, join(EXTENSIONS_DIR, resource.destination));
  }
}

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--all');
if (unknown.length > 0) {
  usage(process.stderr);
  process.exit(64);
}

let chosen = EXTENSIONS;
if (!args.includes('--all')) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('error: the picker needs a terminal, but stdin/stdout is not one.\n');
    process.stderr.write('  Save the script to a file and run it from your shell:\n');
    process.stderr.write('    curl -fsSL ' + REPO_RAW + '/install.mjs -o /tmp/install.mjs && node /tmp/install.mjs\n');
    process.stderr.write('  Or install everything non-interactively: node install.mjs --all\n');
    process.exit(64);
  }
  chosen = await pick(EXTENSIONS);
  if (chosen === null) {
    console.log('Cancelled — nothing installed.');
    process.exit(130);
  }
  if (chosen.length === 0) {
    console.log('Nothing selected — nothing installed.');
    process.exit(0);
  }
}

try {
  await fs.mkdir(EXTENSIONS_DIR, { recursive: true });
  for (const entry of chosen) await install(entry);
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

console.log('Done. Restart or reload Pi to load the extension(s).');
