import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildSourceIndex } from '../src/api/lib/sourceIndex/build';
import { writeSourceIndex } from '../src/api/lib/sourceIndex/store';
import { runCodeMapCli } from './code-map';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-code-map-cli-'));
  write('.tenbo/workspace.yaml', 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  write('.tenbo/overview.md', '# Overview\n');
  write('.tenbo/scopes/editor/architecture.yaml', 'layers:\n  - id: app\n    name: App\n    description: app layer\n    files: ["src/**"]\n');
  write('.tenbo/scopes/editor/layers/app/intent.md', '# App\n');
  write('.tenbo/scopes/editor/layers/app/code-map.md', '# App — Code Map\n\nHand-written notes.\n');
  write('.tenbo/scopes/editor/roadmap.yaml', 'items: []\n');
  write('apps/editor/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2020' }, include: ['src'] }));
  write('apps/editor/src/app.ts', 'export const app = true;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('code-map CLI', () => {
  it('fails clearly when the source index is missing, telling the user to run `index`', () => {
    const result = runCodeMapCli(dir, ['generate', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'missing_source_index',
    });
    expect(result.stderr).toContain('tenbo-dashboard index');
  });

  it('generates the marked structural region and preserves hand-written prose', () => {
    const index = buildSourceIndex(dir);
    writeSourceIndex(dir, index);

    const result = runCodeMapCli(dir, ['generate', '--scope', 'editor', '--layer', 'app', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe('generate');
    expect(payload.layers).toHaveLength(1);
    expect(payload.layers[0].block).toContain('apps/editor/src/app.ts');

    const written = readFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md'), 'utf8');
    expect(written).toContain('Hand-written notes.');
    expect(written).toContain('<!-- tenbo:auto:code-map begin -->');
  });

  it('--check exits non-zero and reports stale_layers when regeneration would change the file', () => {
    const index = buildSourceIndex(dir);
    writeSourceIndex(dir, index);

    const result = runCodeMapCli(dir, ['generate', '--check', '--json']);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.mode).toBe('check');
    expect(payload.stale_layers).toEqual(['editor:app']);
  });

  it('--check exits 0 once the layer has been generated', () => {
    const index = buildSourceIndex(dir);
    writeSourceIndex(dir, index);
    runCodeMapCli(dir, ['generate']);

    const result = runCodeMapCli(dir, ['generate', '--check', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).stale_layers).toEqual([]);
  });

  it('rejects an unrecognized subcommand with usage on stderr', () => {
    const result = runCodeMapCli(dir, ['bogus']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Usage: tenbo-dashboard code-map generate');
  });
});
