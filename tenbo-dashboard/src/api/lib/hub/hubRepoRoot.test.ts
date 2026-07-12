import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveHubRepoRoot } from './hubRepoRoot';
import { findRepoRoot } from '../repoRoot';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-reporoot-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveHubRepoRoot (stubbed git)', () => {
  it('resolves to the parent of an absolute --git-common-dir output', () => {
    const execFileImpl = () => `${path.join(dir, 'main', '.git')}\n` as unknown as ReturnType<typeof execFileSync>;

    const result = resolveHubRepoRoot(dir, { execFileImpl: execFileImpl as typeof execFileSync });

    expect(result).toBe(path.join(dir, 'main'));
  });

  it('resolves a relative --git-common-dir output against cwd', () => {
    const execFileImpl = () => '.git\n' as unknown as ReturnType<typeof execFileSync>;

    const result = resolveHubRepoRoot(dir, { execFileImpl: execFileImpl as typeof execFileSync });

    expect(result).toBe(dir);
  });

  it('falls back to findRepoRoot when git throws (not a repo, git missing, etc.)', () => {
    const execFileImpl = () => {
      throw new Error('fatal: not a git repository');
    };

    const result = resolveHubRepoRoot(dir, { execFileImpl: execFileImpl as unknown as typeof execFileSync });

    expect(result).toBe(findRepoRoot(dir));
  });

  it('falls back to findRepoRoot when git prints nothing', () => {
    const execFileImpl = () => '' as unknown as ReturnType<typeof execFileSync>;

    const result = resolveHubRepoRoot(dir, { execFileImpl: execFileImpl as typeof execFileSync });

    expect(result).toBe(findRepoRoot(dir));
  });
});

function run(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('resolveHubRepoRoot (real git worktree)', () => {
  it('resolves the main checkout and a linked worktree to the SAME shared root', () => {
    const main = path.join(dir, 'main');
    run(dir, ['init', '-q', 'main']);
    run(main, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const wt = path.join(dir, 'wt');
    run(main, ['worktree', 'add', '-q', wt, '-b', 'wt-branch']);

    // The naive findRepoRoot disagrees between the two — that's the bug this
    // fix addresses (a worktree's `.git` is a file, so findRepoRoot resolves
    // to the worktree itself, not the main checkout).
    expect(findRepoRoot(wt)).toBe(wt);
    expect(findRepoRoot(main)).toBe(main);

    const rootFromMain = resolveHubRepoRoot(main);
    const rootFromWorktree = resolveHubRepoRoot(wt);

    // `resolveHubRepoRoot` itself doesn't promise a realpath-resolved value
    // (that normalization happens downstream in `canonicalRepoRoot`), only
    // that every worktree of one repo agrees — so compare realpaths here to
    // avoid false negatives from e.g. macOS's /tmp -> /private/tmp symlink.
    expect(realpathSync(rootFromWorktree!)).toBe(realpathSync(rootFromMain!));
    expect(realpathSync(rootFromMain!)).toBe(realpathSync(main));
  });

  it('does not conflate two unrelated repos', () => {
    const repoA = path.join(dir, 'repoA');
    const repoB = path.join(dir, 'repoB');
    run(dir, ['init', '-q', 'repoA']);
    run(dir, ['init', '-q', 'repoB']);

    expect(realpathSync(resolveHubRepoRoot(repoA)!)).toBe(realpathSync(repoA));
    expect(realpathSync(resolveHubRepoRoot(repoB)!)).toBe(realpathSync(repoB));
    expect(resolveHubRepoRoot(repoA)).not.toBe(resolveHubRepoRoot(repoB));
  });
});
