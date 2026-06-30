import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runImpactCli } from './impact';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-impact-cli-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: app layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/intent.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md'), '# App Map\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'items:\n  - id: ed-001\n    title: App\n    layer: app\n    status: now\n    description: app work\n');
  mkdirSync(path.join(dir, 'apps/editor/src'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/editor/src/app.ts'), 'export const app = true;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('impact CLI', () => {
  it('prints impact context as JSON', () => {
    const result = runImpactCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      changed_files: expect.arrayContaining(['apps/editor/src/app.ts']),
    });
  });

  it('rejects missing since values', () => {
    const result = runImpactCli(dir, ['--since', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'invalid_args',
    });
  });
});
