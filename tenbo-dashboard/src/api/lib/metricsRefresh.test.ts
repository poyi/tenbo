import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureFresh } from './metricsRefresh.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-mr-'));
  const scope = path.join(dir, '.tenbo', 'scopes', 'editor');
  const layer = path.join(scope, 'layers', 'foo');
  mkdirSync(layer, { recursive: true });
  writeFileSync(path.join(dir, '.tenbo', 'workspace.yaml'), 'scopes:\n  - id: editor\n    path: scopes/editor\n');
  writeFileSync(path.join(scope, 'architecture.yaml'), 'scope: editor\nlayers:\n  - id: foo\n    name: Foo\n    description: A small layer.\n    files: ["src/**"]\n    dependencies: { inbound: [], outbound: [], external: [] }\n');
  writeFileSync(path.join(scope, 'roadmap.yaml'), 'items: []\n');
  writeFileSync(path.join(layer, 'intent.md'), '# Foo\n');
  writeFileSync(path.join(layer, 'code-map.md'), '# Foo map\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ensureFresh', () => {
  it('writes metrics.json when it is missing', async () => {
    const metricsPath = path.join(dir, '.tenbo', 'scopes', 'editor', 'metrics.json');
    expect(existsSync(metricsPath)).toBe(false);
    const result = await ensureFresh(dir, 'editor');
    expect(existsSync(metricsPath)).toBe(true);
    expect(result.layers).toBeDefined();
  });

  it('does not rewrite metrics.json when it is fresh', async () => {
    const metricsPath = path.join(dir, '.tenbo', 'scopes', 'editor', 'metrics.json');
    await ensureFresh(dir, 'editor');
    const firstMtime = statSync(metricsPath).mtimeMs;
    const future = new Date(firstMtime + 1000);
    utimesSync(metricsPath, future, future);
    const newMtime = statSync(metricsPath).mtimeMs;
    await ensureFresh(dir, 'editor');
    expect(statSync(metricsPath).mtimeMs).toBe(newMtime);
  });

  it('rewrites metrics.json when a tracked file is newer', async () => {
    const metricsPath = path.join(dir, '.tenbo', 'scopes', 'editor', 'metrics.json');
    await ensureFresh(dir, 'editor');
    // Age metrics.json well into the past so the staleness check fires.
    const stale = new Date(Date.now() - 60_000);
    utimesSync(metricsPath, stale, stale);
    const aged = statSync(metricsPath).mtimeMs;
    await ensureFresh(dir, 'editor');
    const after = statSync(metricsPath).mtimeMs;
    expect(after).toBeGreaterThan(aged);
  });
});
