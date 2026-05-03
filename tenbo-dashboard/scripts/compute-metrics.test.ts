import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runComputeMetrics } from './compute-metrics.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-cm-'));
  const scope = path.join(dir, '.tenbo', 'scopes', 'editor');
  const layer = path.join(scope, 'layers', 'foo');
  mkdirSync(layer, { recursive: true });
  writeFileSync(path.join(dir, '.tenbo', 'workspace.yaml'), 'scopes:\n  - id: editor\n    path: scopes/editor\n');
  writeFileSync(path.join(scope, 'architecture.yaml'), 'scope: editor\nlayers:\n  - id: foo\n    name: Foo\n    description: A small layer.\n    files: ["src/**"]\n    dependencies: { inbound: [], outbound: [], external: [] }\n');
  writeFileSync(path.join(scope, 'roadmap.yaml'), 'items: []\n');
  writeFileSync(path.join(layer, 'intent.md'), '# Foo\n');
  writeFileSync(path.join(layer, 'code-map.md'), '# Foo\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('compute-metrics CLI', () => {
  it('writes metrics.json for the requested scope', async () => {
    const code = await runComputeMetrics({ repoRoot: dir, scope: 'editor' });
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, '.tenbo', 'scopes', 'editor', 'metrics.json'))).toBe(true);
  });

  it('writes metrics for all scopes with --all', async () => {
    const code = await runComputeMetrics({ repoRoot: dir, all: true });
    expect(code).toBe(0);
    expect(existsSync(path.join(dir, '.tenbo', 'scopes', 'editor', 'metrics.json'))).toBe(true);
  });
});
