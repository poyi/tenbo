#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Find the tsx binary by walking up node_modules from this file's directory.
 * Required because npm hoists shared dependencies to a parent node_modules,
 * so `<package>/node_modules/.bin/tsx` may not exist for consumers.
 */
function findTsx() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'tsx');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'tsx'; // last-resort fallback to PATH
}

const [command, ...args] = process.argv.slice(2);

if (command === '--version' || command === '-v' || command === 'version') {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const commands = {
  validate: 'scripts/validate-cli.ts',
  'next-id': 'scripts/next-id.ts',
  metrics: 'scripts/compute-metrics.ts',
  'init-check': 'scripts/init-check.ts',
  sync: 'scripts/sync.ts',
};

// Documented aliases for the bare-launch behavior. Users (and agents) reading
// help shouldn't have to discover that running `tenbo-dashboard` with no args
// launches the dashboard — these subcommand verbs are conventional and now
// explicit. Anything not in `commands` and not in this set is treated as an
// error rather than silently launching. (td-012)
const LAUNCH_ALIASES = new Set(['serve', 'start', 'dev']);

function run(script, scriptArgs) {
  const tsx = findTsx();
  const child = spawn(tsx, [path.join(root, script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('close', (code) => process.exit(code ?? 1));
}

function startDashboard() {
  const launcher = path.join(__dirname, 'launch-dashboard.mjs');
  const child = spawn(process.execPath, [launcher], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, TENBO_CWD: process.cwd() },
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

if (command === 'help' || command === '--help') {
  console.log(`
tenbo-dashboard — local architecture dashboard for .tenbo/ repos

Usage:
  tenbo-dashboard                  Launch the dashboard (http://localhost:5174)
  tenbo-dashboard serve            Same as bare invocation (also: 'start', 'dev')
  tenbo-dashboard sync             Refresh tenbo state after a change (metrics + init-check + validate, surfaces new findings)
  tenbo-dashboard validate         Run validation rules
  tenbo-dashboard init-check       Strict completeness check for fresh init (errors on missing skeletons, file_count:0, etc)
  tenbo-dashboard next-id <prefix> Allocate next roadmap item ID
  tenbo-dashboard metrics --all    Compute scope metrics
  tenbo-dashboard --version        Print package version
  tenbo-dashboard help             Show this help

The dashboard reads/writes .tenbo/ in the current working directory. To
serve a different repo, cd into it before running.
`);
  process.exit(0);
}

if (commands[command]) {
  run(commands[command], args);
} else if (!command || LAUNCH_ALIASES.has(command)) {
  // Bare invocation OR a documented launch alias ('serve' / 'start' / 'dev').
  startDashboard();
} else {
  // Unknown subcommand — surface clearly instead of silently launching.
  // (Pre-td-012 behavior was to fall through; that hid typos.)
  process.stderr.write(`tenbo-dashboard: unknown subcommand '${command}'\n`);
  process.stderr.write(`Run 'tenbo-dashboard help' for usage.\n`);
  process.exit(2);
}
