import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runCommitContextCli } from './commit-context';

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
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-commit-context-cli-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: app layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/intent.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md'), '# App Map\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), 'items:\n  - id: ed-001\n    title: App\n    layer: app\n    status: now\n    type: feature\n    description: app work\n');
  write('apps/editor/src/app.ts');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('commit-context CLI', () => {
  it('prints suggestions and a draft message as JSON', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = runCommitContextCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.suggestions[0]).toMatchObject({ id: 'ed-001' });
    expect(payload.draft_message).toContain('Advances ed-001');
  });

  it('prints a human-readable summary without --json', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = runCommitContextCli(dir, []);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 suggestion(s)');
    expect(result.stdout).toContain('ed-001');
    expect(result.stdout).toContain('Draft message:');
  });

  it('prints only the hook-format block with --hook-format', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = runCommitContextCli(dir, ['--hook-format']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Advances ed-001');
    expect(result.stdout.startsWith('#')).toBe(true);
  });

  it('emits an empty hook-format block with no pending diff', () => {
    const result = runCommitContextCli(dir, ['--hook-format']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('never throws and reports empty suggestions with no pending diff', () => {
    const result = runCommitContextCli(dir, ['--json']);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.suggestions).toEqual([]);
    expect(payload.note).toContain('No pending changes');
  });

  it('rejects a missing --since value', () => {
    const result = runCommitContextCli(dir, ['--since', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: 'invalid_args' });
  });
});
