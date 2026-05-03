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
};

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
  tenbo-dashboard validate         Run validation rules
  tenbo-dashboard init-check       Strict completeness check for fresh init (errors on missing skeletons, file_count:0, etc)
  tenbo-dashboard next-id <prefix> Allocate next roadmap item ID
  tenbo-dashboard metrics --all    Compute scope metrics
  tenbo-dashboard --version        Print package version
  tenbo-dashboard help             Show this help
`);
  process.exit(0);
}

if (commands[command]) {
  run(commands[command], args);
} else {
  // No recognized subcommand — default to launching the dashboard
  // Pass the original command back as an arg in case it was a flag
  startDashboard();
}
