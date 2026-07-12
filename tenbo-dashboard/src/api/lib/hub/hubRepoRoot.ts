/**
 * hubRepoRoot.ts — the shared repo root all worktrees of one repository must
 * agree on for hub identity/lockfile placement (see td-029 / x-004).
 *
 * `findRepoRoot` (repoRoot.ts) walks up looking for a `.git` entry and
 * returns the first directory that has one. That is correct for "where do
 * this process's own `.tenbo/` files live" (a worktree's checked-out files
 * really do live under the worktree root), but wrong for hub *discovery*:
 * in a git worktree, `.git` is a FILE (not a directory) whose contents point
 * at `<main-checkout>/.git/worktrees/<name>`, so `findRepoRoot` resolves to
 * the worktree's own path — not the main checkout the hub server actually
 * runs from. A CLI invocation from a second worktree would then compute a
 * different repo root than the hub's, never find its lockfile, and silently
 * fall back to a direct file write, defeating single-writer coordination.
 *
 * `resolveHubRepoRoot` fixes this by asking git itself for the *common* git
 * directory (`git rev-parse --git-common-dir`), which resolves to the main
 * checkout's `.git` directory for every worktree of the same repository —
 * its parent is the one shared root all worktrees should use for hub
 * lockfile placement and repo-identity comparisons.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { findRepoRoot } from '../repoRoot';

export interface ResolveHubRepoRootOptions {
  /** Injectable for tests. Defaults to `node:child_process`'s `execFileSync`. */
  execFileImpl?: typeof execFileSync;
}

/**
 * Resolve the shared hub repo root for `cwd`. Falls back to
 * `findRepoRoot(cwd)` when git is unavailable, `cwd` isn't inside a git
 * repo, or the git call fails for any reason — fail-open, never throws.
 */
export function resolveHubRepoRoot(cwd: string, opts: ResolveHubRepoRootOptions = {}): string | null {
  const execFileImpl = opts.execFileImpl ?? execFileSync;
  try {
    const out = execFileImpl('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out) {
      const gitCommonDir = path.isAbsolute(out) ? out : path.resolve(cwd, out);
      return path.dirname(gitCommonDir);
    }
  } catch {
    // git unavailable, cwd not a repo, or the command failed — fall through
    // to the plain directory-walk fallback below.
  }
  return findRepoRoot(cwd);
}
