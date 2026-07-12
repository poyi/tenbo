/**
 * lockfile.ts — hub runtime descriptor at `.tenbo/cache/hub.json`.
 *
 * When the dashboard server starts, it writes a small JSON descriptor here so
 * other processes (running elsewhere, possibly in other worktrees sharing the
 * same repo root) can discover a running hub and route mutations through it
 * instead of writing `.tenbo/` files directly (see td-029 / x-004).
 *
 * `.tenbo/cache/` is already gitignored (see `.tenbo/cache/.gitignore`), so
 * this file never lands in git history — it is purely a runtime artifact,
 * stale-tolerant by design (see discover.ts for the liveness + repo-match
 * checks that treat a dead or mismatched lockfile as absent).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveHubRepoRoot } from './hubRepoRoot';

/** Bump when the descriptor shape changes in a way old readers must reject. */
export const HUB_SCHEMA_VERSION = 1;

export interface HubDescriptor {
  pid: number;
  port: number;
  /** Absolute, symlink-resolved repo root — the identity a lockfile is scoped to. */
  repoRoot: string;
  startedAt: string;
  schemaVersion: number;
}

/**
 * All lockfile I/O is keyed on the shared hub repo root (see hubRepoRoot.ts),
 * not the raw `repoRoot` a caller passes in, so every worktree of one
 * repository reads/writes the same `.tenbo/cache/hub.json` regardless of
 * which worktree the caller (server or CLI) happens to be running from.
 */
function hubRoot(repoRoot: string): string {
  return resolveHubRepoRoot(repoRoot) ?? repoRoot;
}

function cacheDir(repoRoot: string): string {
  return path.join(hubRoot(repoRoot), '.tenbo', 'cache');
}

function lockfilePath(repoRoot: string): string {
  return path.join(cacheDir(repoRoot), 'hub.json');
}

/**
 * Resolve a repo root to a canonical absolute path (symlinks resolved) so two
 * different-looking paths to the same repo (e.g. via a symlinked worktree)
 * compare equal. Falls back to `path.resolve` if the path doesn't exist yet
 * or `realpathSync` fails for any reason.
 */
export function canonicalRepoRoot(repoRoot: string): string {
  try {
    return realpathSync(path.resolve(repoRoot));
  } catch {
    return path.resolve(repoRoot);
  }
}

/** Write the hub descriptor for `repoRoot`, creating `.tenbo/cache/` if needed. */
export function writeHubLockfile(repoRoot: string, port: number): HubDescriptor {
  const descriptor: HubDescriptor = {
    pid: process.pid,
    port,
    repoRoot: canonicalRepoRoot(hubRoot(repoRoot)),
    startedAt: new Date().toISOString(),
    schemaVersion: HUB_SCHEMA_VERSION,
  };
  mkdirSync(cacheDir(repoRoot), { recursive: true });
  writeFileSync(lockfilePath(repoRoot), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  return descriptor;
}

/** Read and loosely validate the hub descriptor. Returns null for any malformed/missing file. */
export function readHubLockfile(repoRoot: string): HubDescriptor | null {
  const file = lockfilePath(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<HubDescriptor>;
    if (
      typeof data.pid !== 'number' ||
      typeof data.port !== 'number' ||
      typeof data.repoRoot !== 'string' ||
      typeof data.schemaVersion !== 'number'
    ) {
      return null;
    }
    return data as HubDescriptor;
  } catch {
    return null;
  }
}

/** Remove the lockfile if present. Best-effort — never throws. */
export function removeHubLockfile(repoRoot: string): void {
  const file = lockfilePath(repoRoot);
  try {
    if (existsSync(file)) rmSync(file);
  } catch {
    // best effort — a stray lockfile is caught by discover.ts's liveness check.
  }
}
