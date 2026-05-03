#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const [command, ...args] = process.argv.slice(2);

const commands = {
  validate: 'scripts/validate-cli.ts',
  'next-id': 'scripts/next-id.ts',
  metrics: 'scripts/compute-metrics.ts',
};

function run(script, scriptArgs) {
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [path.join(root, script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  child.on('close', (code) => process.exit(code ?? 1));
}

function startDashboard() {
  // Use Vite's JS API to start the dev server
  const viteScript = `
    import { createServer } from 'vite';
    import { fileURLToPath } from 'node:url';
    import path from 'node:path';
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const server = await createServer({ root, configFile: path.join(root, 'vite.config.ts') });
    await server.listen();
    server.printUrls();
  `;
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, ['--eval', viteScript], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, TENBO_CWD: process.cwd() },
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

if (!command || command === 'help' || command === '--help') {
  console.log(`
tenbo-dashboard — local architecture dashboard for .tenbo/ repos

Usage:
  tenbo-dashboard                  Launch the dashboard (http://localhost:5174)
  tenbo-dashboard validate         Run validation rules
  tenbo-dashboard next-id <prefix> Allocate next roadmap item ID
  tenbo-dashboard metrics --all    Compute scope metrics
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
