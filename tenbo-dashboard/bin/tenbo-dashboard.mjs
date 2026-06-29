#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { topLevelItemHelpLines } from '../scripts/itemCommandRegistry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Find tsx's loader by walking up node_modules from this file's directory.
 * Running the tsx CLI starts an IPC server for parent/child coordination; some
 * sandboxes reject that pipe. `node --import <loader>` runs the same TypeScript
 * entrypoints without that extra IPC listener.
 */
function findTsxLoader() {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', 'tsx', 'dist', 'loader.mjs');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'tsx'; // last-resort fallback to package resolution
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
  archive: 'scripts/archive.ts',
  'commit-ready': 'scripts/commit-ready.ts',
  item: 'scripts/item.ts',
  items: 'scripts/items.ts',
  list: 'scripts/items.ts',
  next: 'scripts/next.ts',
  'work-queue': 'scripts/work-queue.ts',
  context: 'scripts/context.ts',
  hook: 'scripts/hook.ts',
};

// Documented aliases for the bare-launch behavior. Users (and agents) reading
// help shouldn't have to discover that running `tenbo-dashboard` with no args
// launches the dashboard — these subcommand verbs are conventional and now
// explicit. Anything not in `commands` and not in this set is treated as an
// error rather than silently launching. (td-012)
const LAUNCH_ALIASES = new Set(['serve', 'start', 'dev']);

function run(script, scriptArgs) {
  const tsxLoader = findTsxLoader();
  const child = spawn(process.execPath, ['--import', tsxLoader, path.join(root, script), ...scriptArgs], {
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
${topLevelItemHelpLines().join('\n')}
  tenbo-dashboard items            Query roadmap items [--status <status>]
                                   [--verification <status>] [--goal <goal>]
                                   [--type <type>] [--priority <p0|p1|p2|p3>]
                                   [--layer <id>] [--fields <a,b>] [--summary] [--json]
  tenbo-dashboard list             Alias for items
  tenbo-dashboard next             Show next actionable roadmap items [--json]
  tenbo-dashboard work-queue       Compact agent task flow [--status <a,b>]
                                   [--type <type>] [--json]
  tenbo-dashboard context feature  Fetch agent planning context for a natural-language request
                                   --query "<request>" [--json]
  tenbo-dashboard validate         Run validation rules
  tenbo-dashboard init-check       Strict completeness check for fresh init (errors on missing skeletons, file_count:0, etc)
  tenbo-dashboard next-id <prefix> Allocate next roadmap item ID
  tenbo-dashboard metrics --all    Compute scope metrics
  tenbo-dashboard archive          Move old done/dropped items to roadmap-archive.yaml
                                   [--scope <id>] [--days 30] [--max 20]
  tenbo-dashboard hook install     Install opt-in pre-commit validation hook
                                   [--dry-run] [--force]
  tenbo-dashboard hook uninstall   Remove the tenbo pre-commit hook (idempotent)
  tenbo-dashboard commit-ready     Report branch, diff, validation, and staging gates
                                   without committing [--json]
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
