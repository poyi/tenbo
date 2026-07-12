import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runReconcileCli } from './reconcile';
import { readPendingReconciliation, writePendingReconciliation, DOC_FLAG_KIND } from '../src/api/lib/reconciliationFlag';

let dir: string;

function git(args: string[]) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function write(rel: string, content = 'export const value = 1;\n') {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-reconcile-cli-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: app layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/intent.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md'), '# App Map\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'items:\n  - id: ed-001\n    title: App\n    layer: app\n    status: now\n    description: app work\n');
  write('apps/editor/src/app.ts');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reconcile flag CLI', () => {
  it('dry-run reports the plan as JSON without writing', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app']);

    const result = runReconcileCli(dir, ['flag', '--dry-run', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.dry_run).toBe(true);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({ layer: 'editor:app', action: 'append' });
    expect(readPendingReconciliation(dir)).toEqual([]);
  });

  it('applies the plan and writes .tenbo/.pending-reconciliation.yaml', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app']);

    const result = runReconcileCli(dir, ['flag', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.appended).toBe(1);

    const onDisk = readPendingReconciliation(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ layer: 'editor:app', kind: DOC_FLAG_KIND });
  });

  it('prints a human-readable summary without --json', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app']);

    const result = runReconcileCli(dir, ['flag']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('appended');
  });

  it('rejects a missing --since value', () => {
    const result = runReconcileCli(dir, ['flag', '--since', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: 'invalid_args' });
  });

  it('is fail-open (ok:true, zero entries) on a root commit with no HEAD~1', () => {
    const result = runReconcileCli(dir, ['flag', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.appended).toBe(0);
  });
});

describe('reconcile clear CLI', () => {
  beforeEach(() => {
    writePendingReconciliation(dir, [
      { opened_at: '2026-01-01', layer: 'editor:app', kind: DOC_FLAG_KIND, description: 'flag a', source_commit: 'sha-a' },
      { opened_at: '2026-01-02', layer: 'editor:tools', kind: DOC_FLAG_KIND, description: 'flag b', source_commit: 'sha-b' },
    ]);
  });

  it('removes matching entries by --layer', () => {
    const result = runReconcileCli(dir, ['clear', '--layer', 'editor:app', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.removed).toHaveLength(1);
    expect(readPendingReconciliation(dir)).toHaveLength(1);
  });

  it('removes matching entries by --commit', () => {
    const result = runReconcileCli(dir, ['clear', '--commit', 'sha-b', '--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.removed).toHaveLength(1);
    expect(readPendingReconciliation(dir)).toHaveLength(1);
  });

  it('requires at least one of --layer / --commit', () => {
    const result = runReconcileCli(dir, ['clear', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: 'invalid_args' });
  });
});

describe('reconcile help', () => {
  it('prints help with no action', () => {
    const result = runReconcileCli(dir, []);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('reconcile flag');
    expect(result.stdout).toContain('reconcile clear');
  });

  it('rejects an unknown action', () => {
    const result = runReconcileCli(dir, ['bogus']);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown action');
  });
});
