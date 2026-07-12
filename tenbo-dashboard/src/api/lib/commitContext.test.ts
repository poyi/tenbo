import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCommitContext } from './commitContext';

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
    '    type: feature',
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
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-commit-context-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  setupTenbo();
  write('apps/editor/src/app.ts');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveCommitContext', () => {
  it('proposes ranked item suggestions and a draft message referencing the top match', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = resolveCommitContext(dir);

    expect(result.ok).toBe(true);
    expect(result.changed_files).toContain('apps/editor/src/app.ts');
    expect(result.suggestions[0]).toMatchObject({ id: 'ed-001', status: 'now' });
    expect(result.draft_message).toContain('feat(editor):');
    expect(result.draft_message).toContain('Advances ed-001: Active app work');
    expect(result.hook_format).toContain('Advances ed-001: Active app work');
  });

  it('truncates by code point so an emoji straddling the cut is never split into a lone surrogate (NIT regression)', () => {
    // Title engineered so the emoji's UTF-16 surrogate pair sits exactly on
    // the old naive `.slice(0, 71)` boundary: 14-char "feat(editor): "
    // prefix + 56 'a's lands the emoji's high surrogate at UTF-16 index 70.
    const longTitle = `${'a'.repeat(56)}\u{1F389}${'c'.repeat(10)}`;
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      `    title: "${longTitle}"`,
      '    layer: app',
      '    status: now',
      '    type: feature',
      '    description: active app work',
      '',
    ].join('\n'));
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = resolveCommitContext(dir);

    expect(result.ok).toBe(true);
    const subjectLine = (result.draft_message as string).split('\n')[0];
    // No lone (unpaired) surrogate anywhere in the subject.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(subjectLine)).toBe(false);
    // The emoji itself survived intact (not split), since it fell within budget.
    expect(subjectLine).toContain('\u{1F389}');
    expect(subjectLine.endsWith('…')).toBe(true);
  });

  it('prefers files_to_read matches and surfaces multiple suggestions in the body', () => {
    write('apps/editor/src/app.ts', 'export const changed = true;\n');
    write('apps/editor/scripts/build.ts');

    const result = resolveCommitContext(dir);

    expect(result.suggestions.map((s) => s.id)).toEqual(expect.arrayContaining(['ed-001', 'ed-002']));
    // files_to_read (score 100) should outrank an active-layer match (score 50).
    expect(result.suggestions[0].id).toBe('ed-002');
    expect(result.draft_message).toContain('Advances ed-002: Explicit file work');
    expect(result.draft_message).toContain('Advances ed-001: Active app work');
  });

  it('is fail-open with a clear note and no throw when there is no pending diff', () => {
    const result = resolveCommitContext(dir);

    expect(result.ok).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.draft_message).toBeNull();
    expect(result.hook_format).toBeNull();
    expect(result.note).toContain('No pending changes');
  });

  it('is fail-open with empty suggestions when the diff matches no roadmap item', () => {
    write('package.json', '{"private":true}\n');

    const result = resolveCommitContext(dir);

    expect(result.ok).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.draft_message).toContain('chore: update 1 file');
    expect(result.note).toContain('No roadmap items matched');
  });

  it('sanitizes newlines in a matched item title so hookFormat lines stay comment-prefixed (BLOCKER regression)', () => {
    writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
      'items:',
      '  - id: ed-001',
      "    title: |-",
      '      Active app work',
      '      exec: rm -rf /',
      '    layer: app',
      '    status: now',
      '    type: feature',
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
    write('apps/editor/src/app.ts', 'export const changed = true;\n');

    const result = resolveCommitContext(dir);

    expect(result.ok).toBe(true);
    expect(result.suggestions[0].title).not.toContain('\n');
    expect(result.hook_format).not.toBeNull();
    const hookLines = (result.hook_format as string).split('\n').filter((line) => line.length > 0);
    for (const line of hookLines) {
      expect(line.startsWith('#')).toBe(true);
    }
    expect(result.draft_message).not.toBeNull();
    const subjectLine = (result.draft_message as string).split('\n')[0];
    expect(subjectLine.includes('\n')).toBe(false);
  });

  it('is fail-open (never throws) outside a git repository', () => {
    const nonRepo = mkdtempSync(path.join(tmpdir(), 'tenbo-commit-context-nogit-'));
    try {
      expect(() => resolveCommitContext(nonRepo)).not.toThrow();
      const result = resolveCommitContext(nonRepo);
      expect(result.ok).toBe(true);
      expect(result.suggestions).toEqual([]);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
