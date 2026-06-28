import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runCommitReadyCli } from './commit-ready';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-commit-ready-cli-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['checkout', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: next',
    '    description: first item',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('commit-ready CLI', () => {
  it('reports branch, dirty files, diff check, and validation without committing', () => {
    const result = runCommitReadyCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      branch: expect.objectContaining({ current: 'main' }),
      diff_check: expect.objectContaining({ exitCode: 0 }),
      validation: expect.objectContaining({ errors: 0 }),
    });
    expect(payload.dirty_files.length).toBeGreaterThan(0);
    expect(payload.recommended_gates).toContain('git diff --check');
  });
});
