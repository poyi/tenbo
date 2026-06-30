import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { collectChangedFiles, resolveImpact } from './impact';

let dir: string;

function git(args: string[]) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function write(rel: string, content = 'export const value = 1;\n') {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function setupTenbo() {
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/tools'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), [
    'scopes:',
    '  - id: editor',
    '    path: apps/editor',
    '    description: editor scope',
    'cross_cutting: []',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), [
    'layers:',
    '  - id: app',
    '    name: App',
    '    description: application layer',
    '    files: ["src/**"]',
    '  - id: tools',
    '    name: Tools',
    '    description: scripts and command helpers',
    '    files: ["scripts/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/intent.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md'), '# App Map\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/tools/intent.md'), '# Tools\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/tools/code-map.md'), '# Tools Map\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: Active app work',
    '    layer: app',
    '    status: now',
    '    description: active app work',
    '  - id: ed-002',
    '    title: Explicit file work',
    '    layer: tools',
    '    status: later',
    '    description: explicit file work',
    '    files_to_read:',
    '      - apps/editor/scripts/build.ts',
    '',
  ].join('\n'));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-impact-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  setupTenbo();
  write('apps/editor/src/app.ts');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('impact analysis', () => {
  it('collects staged unstaged untracked and committed changed files', () => {
    write('apps/editor/src/unstaged.ts');
    write('apps/editor/scripts/staged.ts');
    git(['add', 'apps/editor/scripts/staged.ts']);
    write('apps/editor/src/untracked.ts');
    git(['commit', '-m', 'add staged']);

    const summary = collectChangedFiles(dir, { since: 'HEAD~1' });

    expect(summary.compared_ref).toBe('HEAD~1');
    expect(summary.changed_files).toEqual([
      'apps/editor/scripts/staged.ts',
      'apps/editor/src/unstaged.ts',
      'apps/editor/src/untracked.ts',
    ]);
    expect(summary.sources).toEqual(expect.arrayContaining(['since', 'worktree', 'status']));
  });

  it('maps changed files to layers stale docs related items and uncovered files', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');
    write('apps/editor/scripts/build.ts');
    write('package.json', '{"private":true}\n');

    const impact = resolveImpact(dir);

    expect(impact.affected_layers).toEqual([
      expect.objectContaining({
        scope: 'editor',
        layer: 'app',
        changed_files: ['apps/editor/src/app.ts'],
      }),
      expect.objectContaining({
        scope: 'editor',
        layer: 'tools',
        changed_files: ['apps/editor/scripts/build.ts'],
      }),
    ]);
    expect(impact.stale_docs).toEqual(expect.arrayContaining([
      '.tenbo/scopes/editor/layers/app/code-map.md',
      '.tenbo/scopes/editor/layers/tools/code-map.md',
    ]));
    expect(impact.related_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ed-001', reason: expect.stringContaining('active item') }),
      expect.objectContaining({ id: 'ed-002', reason: expect.stringContaining('files_to_read') }),
    ]));
    expect(impact.uncovered_files).toEqual(['package.json']);
    expect(impact.recommended_checks).toContain('node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json');
  });
});
