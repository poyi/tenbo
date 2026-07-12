import type { Connect } from 'vite';
import { canonicalRepoRoot, HUB_SCHEMA_VERSION } from '../lib/hub/lockfile';
import { resolveHubRepoRoot } from '../lib/hub/hubRepoRoot';
import { json } from '../lib/http';

/**
 * GET /api/hub/health — used by `discoverHub` (caller side) to confirm a
 * lockfile's port is actually served by the hub it claims to be, not some
 * unrelated process that happened to rebind the same port after the hub
 * died. Returns this process's own view of repoRoot/pid so the caller can
 * cross-check against the lockfile it read. `repoRoot` is resolved through
 * the same shared-hub-root logic as the lockfile write (hubRepoRoot.ts) so
 * this matches the descriptor and any caller's computed root regardless of
 * which worktree the server process itself happens to run from.
 */
export function hubHealthRoute(repoRoot: string): Connect.NextHandleFunction {
  const canonical = canonicalRepoRoot(resolveHubRepoRoot(repoRoot) ?? repoRoot);
  return (req, res, next) => {
    if (req.url !== '/api/hub/health' || req.method !== 'GET') return next();
    json(res, {
      ok: true,
      repoRoot: canonical,
      pid: process.pid,
      schemaVersion: HUB_SCHEMA_VERSION,
    });
  };
}
