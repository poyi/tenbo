import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runItemCli } from './item';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-item-cli-'));
  mkdirSync(path.join(dir, '.git'));
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

describe('item CLI', () => {
  it('prints canonical JSON for item show --json', () => {
    const result = runItemCli(dir, ['show', 'ed-001', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      item: { id: 'ed-001', status: 'next' },
      scope: 'editor',
    });
  });

  it('sets status and prints concise text by default', () => {
    const result = runItemCli(dir, ['set-status', 'ed-001', 'done']);

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'ed-001 status: done\n',
      stderr: '',
    });
  });

  it('sets verification status and evidence', () => {
    const result = runItemCli(dir, [
      'verify',
      'ed-001',
      '--status',
      'pending_live',
      '--evidence',
      'npm test -- --run',
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).item.verification).toMatchObject({
      status: 'pending_live',
      evidence: ['npm test -- --run'],
    });
  });

  it('returns a structured error for missing items', () => {
    const result = runItemCli(dir, ['show', 'ed-999', '--json']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });
});
