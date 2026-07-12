import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  planReconciliationFlag,
  applyReconciliationFlag,
  clearPendingReconciliation,
  readPendingReconciliation,
  writePendingReconciliation,
  DOC_FLAG_KIND,
} from './reconciliationFlag';

let dir: string;

function git(args: string[]) {
  execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function headSha(): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
    '',
  ].join('\n'));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-reconciliation-flag-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  setupTenbo();
  write('apps/editor/src/app.ts');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('planReconciliationFlag', () => {
  it('plans one append entry per affected layer for the last commit (default --since HEAD~1)', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);
    const sha = headSha();

    const plan = planReconciliationFlag(dir);

    expect(plan.ok).toBe(true);
    expect(plan.commit_sha).toBe(sha);
    expect(plan.since).toBe('HEAD~1');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      layer: 'editor:app',
      kind: DOC_FLAG_KIND,
      source_commit: sha,
      action: 'append',
    });
    expect(plan.entries[0].description).toContain(sha.slice(0, 12));
  });

  it('does NOT flag a layer whose files are only dirty in the working tree (untracked or unstaged), not part of the committed diff', () => {
    // Pre-existing tracked file under layer tools' glob (scripts/**),
    // committed before the commit under test.
    write('apps/editor/scripts/build.ts');
    git(['add', '.']);
    git(['commit', '-m', 'add tools file']);

    // The commit under test touches ONLY layer app.
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer only']);
    const sha = headSha();

    // Leave the tree dirty under layer tools' glob AFTER the commit: one
    // untracked file, and one unstaged modification to the already-tracked
    // tools file. Neither is part of the commit just made — a post-commit
    // hook must not attribute either to it (reviewer repro for the blocker
    // where collectChangedFiles unioned worktree/staged/status sources
    // into the post-commit flag path).
    write('apps/editor/scripts/untracked.ts'); // untracked
    write('apps/editor/scripts/build.ts', 'export const dirty = true;\n'); // unstaged modification

    const plan = planReconciliationFlag(dir); // default since: HEAD~1

    expect(plan.ok).toBe(true);
    expect(plan.commit_sha).toBe(sha);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      layer: 'editor:app',
      kind: DOC_FLAG_KIND,
      source_commit: sha,
      action: 'append',
    });
    expect(plan.entries.map((e) => e.layer)).not.toContain('editor:tools');
    expect(plan.entries[0].description).toContain(sha.slice(0, 12));
    // changed_files reported should reflect ONLY the committed diff, not
    // the dirty working-tree files left under layer tools' glob.
    expect(plan.changed_files).toEqual(['apps/editor/src/app.ts']);
  });

  it('is fail-open on a root commit with no HEAD~1: ok true, zero entries, explanatory note', () => {
    // `dir` only has the single initial commit from beforeEach — HEAD~1 doesn't exist.
    const plan = planReconciliationFlag(dir);

    expect(plan.ok).toBe(true);
    expect(plan.entries).toEqual([]);
    expect(plan.commit_sha).toBe(headSha());
  });

  it('is fail-open outside a git repository entirely: ok true, null sha, zero entries', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'tenbo-reconciliation-flag-no-git-'));
    try {
      // Valid .tenbo/ but no .git — resolveHeadSha can't resolve HEAD, so
      // this exercises the "not a repo" branch rather than a readState throw.
      writeFileSync(path.join(bare, 'workspace.yaml'), 'scopes: []\ncross_cutting: []\n');
      mkdirSync(path.join(bare, '.tenbo'), { recursive: true });
      writeFileSync(path.join(bare, '.tenbo/workspace.yaml'), 'scopes: []\ncross_cutting: []\n');
      writeFileSync(path.join(bare, '.tenbo/overview.md'), '# Overview\n');

      const plan = planReconciliationFlag(bare);
      expect(plan.ok).toBe(true);
      expect(plan.commit_sha).toBeNull();
      expect(plan.entries).toEqual([]);
      expect(plan.note).toContain('Not inside a git repository');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is fail-open (never throws) when .tenbo/ is entirely missing', () => {
    const noTenbo = mkdtempSync(path.join(tmpdir(), 'tenbo-reconciliation-flag-no-tenbo-'));
    try {
      execFileSync('git', ['init'], { cwd: noTenbo, stdio: 'ignore' });
      execFileSync('git', ['-C', noTenbo, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', noTenbo, 'config', 'user.name', 'Test User']);
      writeFileSync(path.join(noTenbo, 'a.txt'), 'a\n');
      execFileSync('git', ['-C', noTenbo, 'add', '.']);
      execFileSync('git', ['-C', noTenbo, 'commit', '-m', 'init']);

      expect(() => planReconciliationFlag(noTenbo)).not.toThrow();
      const plan = planReconciliationFlag(noTenbo);
      expect(plan.ok).toBe(true);
      expect(plan.entries).toEqual([]);
      expect(plan.note.length).toBeGreaterThan(0);
    } finally {
      rmSync(noTenbo, { recursive: true, force: true });
    }
  });

  it('marks an exact (layer, source_commit) repeat as skip-duplicate', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);
    const sha = headSha();

    const firstPlan = planReconciliationFlag(dir);
    applyReconciliationFlag(dir, firstPlan);

    const secondPlan = planReconciliationFlag(dir);
    expect(secondPlan.entries).toHaveLength(1);
    expect(secondPlan.entries[0]).toMatchObject({ action: 'skip-duplicate', source_commit: sha, layer: 'editor:app' });
    expect(secondPlan.note).toContain('already flagged');
  });

  it('marks a new commit on an already-flagged layer as refresh (not a pile-up)', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'first touch']);
    applyReconciliationFlag(dir, planReconciliationFlag(dir));

    write('apps/editor/src/app.ts', 'export const value = 3;\n');
    git(['add', '.']);
    git(['commit', '-m', 'second touch']);
    const secondSha = headSha();

    const plan = planReconciliationFlag(dir);
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ action: 'refresh', layer: 'editor:app', source_commit: secondSha });
  });
});

describe('applyReconciliationFlag', () => {
  it('writes one entry per affected layer to .tenbo/.pending-reconciliation.yaml', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);
    const sha = headSha();

    const result = applyReconciliationFlag(dir, planReconciliationFlag(dir));

    expect(result.appended).toBe(1);
    expect(result.refreshed).toBe(0);
    expect(result.skipped).toBe(0);

    const onDisk = readPendingReconciliation(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({ layer: 'editor:app', kind: DOC_FLAG_KIND, source_commit: sha });

    const abs = path.join(dir, '.tenbo/.pending-reconciliation.yaml');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toContain('opened_at:');
  });

  it('does not duplicate an entry when applied twice for the same commit', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);

    applyReconciliationFlag(dir, planReconciliationFlag(dir));
    const second = applyReconciliationFlag(dir, planReconciliationFlag(dir));

    expect(second.appended).toBe(0);
    expect(second.skipped).toBe(1);
    expect(readPendingReconciliation(dir)).toHaveLength(1);
  });

  it('refreshes (does not pile up) the open doc-flag entry for a layer across two commits', () => {
    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'first touch']);
    applyReconciliationFlag(dir, planReconciliationFlag(dir));

    write('apps/editor/src/app.ts', 'export const value = 3;\n');
    git(['add', '.']);
    git(['commit', '-m', 'second touch']);
    const secondSha = headSha();

    const result = applyReconciliationFlag(dir, planReconciliationFlag(dir));
    expect(result.refreshed).toBe(1);
    expect(result.appended).toBe(0);

    const onDisk = readPendingReconciliation(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].source_commit).toBe(secondSha);
  });

  it('leaves non-doc-flag entries (e.g. intent_drift from the sk-035 behavior) untouched', () => {
    writePendingReconciliation(dir, [
      { opened_at: '2026-01-01', layer: 'editor:app', kind: 'intent_drift', description: 'manual note', source_commit: 'deadbeef' },
    ]);

    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);

    applyReconciliationFlag(dir, planReconciliationFlag(dir));

    const onDisk = readPendingReconciliation(dir);
    expect(onDisk).toHaveLength(2);
    expect(onDisk.find((e) => e.kind === 'intent_drift')).toMatchObject({ description: 'manual note' });
    expect(onDisk.find((e) => e.kind === DOC_FLAG_KIND)).toBeDefined();
  });

  it('never touches code-map.md, roadmap.yaml, or any doc — only the pending-reconciliation file', () => {
    const codeMapPath = path.join(dir, '.tenbo/scopes/editor/layers/app/code-map.md');
    const roadmapPath = path.join(dir, '.tenbo/scopes/editor/roadmap.yaml');
    const codeMapBefore = readFileSync(codeMapPath, 'utf8');
    const roadmapBefore = readFileSync(roadmapPath, 'utf8');

    write('apps/editor/src/app.ts', 'export const value = 2;\n');
    git(['add', '.']);
    git(['commit', '-m', 'touch app layer']);
    applyReconciliationFlag(dir, planReconciliationFlag(dir));

    expect(readFileSync(codeMapPath, 'utf8')).toBe(codeMapBefore);
    expect(readFileSync(roadmapPath, 'utf8')).toBe(roadmapBefore);
  });
});

describe('clearPendingReconciliation', () => {
  beforeEach(() => {
    writePendingReconciliation(dir, [
      { opened_at: '2026-01-01', layer: 'editor:app', kind: DOC_FLAG_KIND, description: 'flag a', source_commit: 'sha-a' },
      { opened_at: '2026-01-02', layer: 'editor:tools', kind: DOC_FLAG_KIND, description: 'flag b', source_commit: 'sha-b' },
      { opened_at: '2026-01-03', layer: 'editor:app', kind: 'intent_drift', description: 'manual', source_commit: 'sha-c' },
    ]);
  });

  it('removes entries matching --layer', () => {
    const result = clearPendingReconciliation(dir, { layer: 'editor:tools' });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].source_commit).toBe('sha-b');
    expect(readPendingReconciliation(dir)).toHaveLength(2);
  });

  it('removes entries matching --commit', () => {
    const result = clearPendingReconciliation(dir, { commit: 'sha-a' });
    expect(result.removed).toHaveLength(1);
    expect(readPendingReconciliation(dir)).toHaveLength(2);
  });

  it('AND-combines --layer and --commit when both given', () => {
    const result = clearPendingReconciliation(dir, { layer: 'editor:app', commit: 'sha-c' });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].kind).toBe('intent_drift');
    expect(readPendingReconciliation(dir)).toHaveLength(2);
  });

  it('removes nothing and reports so when neither filter is given', () => {
    const result = clearPendingReconciliation(dir, {});
    expect(result.removed).toEqual([]);
    expect(result.remaining).toBe(3);
    expect(readPendingReconciliation(dir)).toHaveLength(3);
  });

  it('deletes the file once the last entry is cleared', () => {
    clearPendingReconciliation(dir, { layer: 'editor:tools' });
    clearPendingReconciliation(dir, { layer: 'editor:app' });

    const abs = path.join(dir, '.tenbo/.pending-reconciliation.yaml');
    expect(existsSync(abs)).toBe(false);
    expect(readPendingReconciliation(dir)).toEqual([]);
  });
});
