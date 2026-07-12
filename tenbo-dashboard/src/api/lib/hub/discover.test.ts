import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverHub } from './discover';
import { canonicalRepoRoot, writeHubLockfile } from './lockfile';

let dir: string;
let otherDir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-discover-'));
  otherDir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-discover-other-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

function okHealthResponse(repoRoot: string, pid: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, repoRoot, pid, schemaVersion: 1 }),
  } as Response;
}

describe('discoverHub', () => {
  it('returns null when no lockfile exists', async () => {
    const result = await discoverHub(dir);
    expect(result).toBeNull();
  });

  it('returns the descriptor when repoRoot, pid liveness, and health check all match', async () => {
    writeHubLockfile(dir, 5199);
    const fetchImpl = vi.fn().mockResolvedValue(okHealthResponse(canonicalRepoRoot(dir), process.pid));

    const result = await discoverHub(dir, { fetchImpl });

    expect(result).toMatchObject({ port: 5199, pid: process.pid });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:5199/api/hub/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('rejects when the lockfile repoRoot does not match the caller repo root (repo-scoping, acceptance criterion 3)', async () => {
    // Write a lockfile inside `dir` but hand-craft its repoRoot field to point
    // elsewhere, simulating a stale lockfile left over from a moved/renamed
    // checkout or a copy-paste mistake.
    const descriptor = writeHubLockfile(dir, 5199);
    const fs = await import('node:fs');
    fs.writeFileSync(
      path.join(dir, '.tenbo', 'cache', 'hub.json'),
      JSON.stringify({ ...descriptor, repoRoot: canonicalRepoRoot(otherDir) }),
    );
    const fetchImpl = vi.fn();

    const result = await discoverHub(dir, { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // rejected before ever making a network call
  });

  it('rejects a lockfile whose pid is dead', async () => {
    const descriptor = writeHubLockfile(dir, 5199);
    // A pid that is astronomically unlikely to be alive.
    const deadPid = 999999;
    const fs = await import('node:fs');
    fs.writeFileSync(
      path.join(dir, '.tenbo', 'cache', 'hub.json'),
      JSON.stringify({ ...descriptor, pid: deadPid }),
    );
    const fetchImpl = vi.fn();

    const result = await discoverHub(dir, { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects when the health check request fails (hub crashed but lockfile lingers)', async () => {
    writeHubLockfile(dir, 5199);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await discoverHub(dir, { fetchImpl });
    expect(result).toBeNull();
  });

  it('rejects when the health check responds but reports a different repoRoot (port reused by unrelated process)', async () => {
    writeHubLockfile(dir, 5199);
    const fetchImpl = vi.fn().mockResolvedValue(okHealthResponse('/some/unrelated/repo', process.pid));

    const result = await discoverHub(dir, { fetchImpl });
    expect(result).toBeNull();
  });

  it('rejects when the health check responds with a non-ok HTTP status', async () => {
    writeHubLockfile(dir, 5199);
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);

    const result = await discoverHub(dir, { fetchImpl });
    expect(result).toBeNull();
  });
});

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('discoverHub across git worktrees (td-029 cross-worktree fix)', () => {
  // A CLI run from a linked worktree must find the lockfile the hub server
  // wrote from the main checkout — `.git` in a worktree is a FILE, not a
  // directory, so the naive `findRepoRoot` walk would resolve to the
  // worktree's own path and never see the main checkout's lockfile at all.
  it('finds the hub from a second worktree of the same repo', async () => {
    const main = path.join(dir, 'main');
    run(dir, ['init', '-q', 'main']);
    run(main, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const worktree = path.join(dir, 'wt');
    run(main, ['worktree', 'add', '-q', worktree, '-b', 'wt-branch']);

    // Hub server starts in the main checkout and writes its lockfile there.
    const descriptor = writeHubLockfile(main, 5299);
    expect(descriptor.repoRoot).toBe(canonicalRepoRoot(main));

    const fetchImpl = vi.fn().mockResolvedValue(okHealthResponse(descriptor.repoRoot, process.pid));

    // CLI invocation happens from the linked worktree, not the main checkout.
    const result = await discoverHub(worktree, { fetchImpl });

    expect(result).toMatchObject({ port: 5299, pid: process.pid, repoRoot: canonicalRepoRoot(main) });
  });

  it('still rejects a hub belonging to a genuinely different repository', async () => {
    const repoA = path.join(dir, 'repoA');
    const repoB = path.join(dir, 'repoB');
    run(dir, ['init', '-q', 'repoA']);
    run(dir, ['init', '-q', 'repoB']);

    // A hub is running for repoA...
    const descriptor = writeHubLockfile(repoA, 5399);
    const fetchImpl = vi.fn().mockResolvedValue(okHealthResponse(descriptor.repoRoot, process.pid));

    // ...but the lockfile lookup for repoB must never see it (different repos
    // don't share a `.tenbo/cache/hub.json`, so this is really testing that
    // repoB's own empty cache dir yields no lockfile at all).
    const result = await discoverHub(repoB, { fetchImpl });

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
