import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runIndexCli } from './index';
import { readSourceIndex } from '../src/api/lib/sourceIndex/store';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-index-cli-'));
  mkdirSync(path.join(dir, '.git'));
  write('.tenbo/workspace.yaml', [
    'scopes:',
    '  - id: dashboard',
    '    path: tenbo-dashboard',
    '    description: dashboard scope',
    'cross_cutting: []',
    '',
  ].join('\n'));
  write('.tenbo/overview.md', '# Overview\n');
  write('.tenbo/scopes/dashboard/architecture.yaml', [
    'layers:',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: CLI helpers',
    '    files: ["scripts/**"]',
    '',
  ].join('\n'));
  write('.tenbo/scopes/dashboard/roadmap.yaml', 'items: []\n');
  write('.tenbo/scopes/dashboard/layers/cli-tools/intent.md', '# CLI Tools\n');
  write('.tenbo/scopes/dashboard/layers/cli-tools/code-map.md', '# CLI Map\n');
  write('tenbo-dashboard/scripts/context.ts', 'export const context = true;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('index CLI', () => {
  it('builds the source index and returns JSON', async () => {
    const result = runIndexCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({ ok: true, mode: 'rebuild', freshness: { status: 'fresh' } });
    expect(readSourceIndex(dir)?.files.map((file) => file.path)).toContain('tenbo-dashboard/scripts/context.ts');
  });

  it('skips --if-stale when the existing index is fresh', async () => {
    runIndexCli(dir, ['--json']);
    const firstGeneratedAt = readSourceIndex(dir)?.generated_at;

    const result = runIndexCli(dir, ['--if-stale', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe('reuse');
    expect(readSourceIndex(dir)?.generated_at).toBe(firstGeneratedAt);
  });
});
