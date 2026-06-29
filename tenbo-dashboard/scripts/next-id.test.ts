import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { allocateNextId, STALE_LOCK_MS } from './next-id';

// Resolve repo paths from cwd — Vitest's `import.meta.url` is not a `file:` URL
// under jsdom. Vitest runs from the package root, so cwd === tenbo-dashboard.
const APP_ROOT = process.cwd();
const SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'next-id.ts');
const TSX_LOADER = path.join(APP_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const created: string[] = [];

afterEach(() => {
  while (created.length) {
    const root = created.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tenbo-nextid-'));
  created.push(root);
  // .git marker so findRepoRoot treats this as a repo (not strictly needed since
  // tests pass repoRoot directly, but harmless).
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, '.tenbo', 'scopes', 'editor'), { recursive: true });
  writeFileSync(
    path.join(root, '.tenbo', 'workspace.yaml'),
    'scopes:\n  - id: editor\n    prefix: ed\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n',
  );
  return root;
}

function writeRoadmap(root: string, scopeRel: string, ids: string[]): void {
  const items = ids.length ? ids.map((id) => `  - id: ${id}\n    title: t\n`).join('') : '';
  const body = `items:\n${items}`;
  writeFileSync(path.join(root, '.tenbo', scopeRel, 'roadmap.yaml'), body);
}

describe('next-id allocator', () => {
  it('returns prefix-001 for an empty roadmap', () => {
    const root = makeRoot();
    writeRoadmap(root, 'scopes/editor', []);
    expect(allocateNextId({ repoRoot: root, prefix: 'ed' })).toBe('ed-001');
  });

  it('returns ed-059 when ed-001..ed-058 exist', () => {
    const root = makeRoot();
    const ids = Array.from({ length: 58 }, (_, i) => `ed-${String(i + 1).padStart(3, '0')}`);
    writeRoadmap(root, 'scopes/editor', ids);
    expect(allocateNextId({ repoRoot: root, prefix: 'ed' })).toBe('ed-059');
  });

  it('returns x-002 when only x-001 exists in workspace roadmap', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, '.tenbo', 'roadmap.yaml'), 'items:\n  - id: x-001\n    title: t\n');
    expect(allocateNextId({ repoRoot: root, prefix: 'x' })).toBe('x-002');
  });

  it('reclaims stale lock files older than 60s', () => {
    const root = makeRoot();
    writeRoadmap(root, 'scopes/editor', []);
    // Pre-create a stale lock for ed-001.
    const lockDir = path.join(root, '.tenbo', '.id-locks');
    mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, 'ed-001.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, ts: '2020-01-01T00:00:00Z' }));
    const ancient = (Date.now() - STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lockPath, ancient, ancient);

    const id = allocateNextId({ repoRoot: root, prefix: 'ed' });
    // Stale lock reclaimed → ed-001 returned.
    expect(id).toBe('ed-001');
  });

  it('skips past fresh locks (simulated concurrent allocation)', () => {
    const root = makeRoot();
    writeRoadmap(root, 'scopes/editor', []);
    // Simulate another caller having just claimed ed-001 by creating a fresh lock.
    const id1 = allocateNextId({ repoRoot: root, prefix: 'ed' });
    expect(id1).toBe('ed-001');
    const id2 = allocateNextId({ repoRoot: root, prefix: 'ed' });
    expect(id2).toBe('ed-002');
    const id3 = allocateNextId({ repoRoot: root, prefix: 'ed' });
    expect(id3).toBe('ed-003');
    // Lock files for each should now exist.
    const locks = readdirSync(path.join(root, '.tenbo', '.id-locks')).sort();
    expect(locks).toEqual(['ed-001.lock', 'ed-002.lock', 'ed-003.lock']);
  });

  it('concurrent child processes never return the same id', () => {
    const root = makeRoot();
    writeRoadmap(root, 'scopes/editor', []);

    // Fan out N parallel child processes that all try to allocate `ed`.
    const N = 5;
    const procs = Array.from({ length: N }, () =>
      spawnSync(process.execPath, ['--import', TSX_LOADER, SCRIPT_PATH, 'ed'], {
        cwd: root,
        encoding: 'utf8',
      }),
    );
    const ids = procs.map((p) => {
      expect(p.status, `stderr: ${p.stderr}`).toBe(0);
      return p.stdout.trim();
    });
    const unique = new Set(ids);
    expect(unique.size).toBe(N);
    // All should match the ed-NNN pattern.
    for (const id of ids) expect(id).toMatch(/^ed-\d{3}$/);
  });

  it('returns no-op gracefully when prefix has no roadmap', () => {
    const root = makeRoot();
    // No roadmap file at all → empty existing → starts at 001.
    expect(allocateNextId({ repoRoot: root, prefix: 'ed' })).toBe('ed-001');
  });
});

// Sanity: confirm the module exports the constant tests rely on.
describe('exports', () => {
  it('exports STALE_LOCK_MS = 60000', () => {
    expect(STALE_LOCK_MS).toBe(60_000);
  });
});
