/**
 * discover.ts — repo-scoped hub discovery for mutation routing.
 *
 * `discoverHub` is the single Data-Layer entrypoint the item mutation
 * entrypoint (scripts/item.ts) calls before every mutation: read the
 * lockfile, and treat it as absent unless ALL of the following hold:
 *
 *   1. Its `repoRoot` canonically matches the caller's SHARED hub repo root
 *      (see hubRepoRoot.ts — this is the main-checkout root, so callers in
 *      any worktree of the same repo agree with the hub's lockfile; never
 *      route a mutation to a hub serving a genuinely different repo —
 *      acceptance criterion 3).
 *   2. Its `pid` is still alive.
 *   3. A live health-check request to its `port` succeeds AND the responding
 *      server's own view of `repoRoot`/`pid` also matches — this guards
 *      against a stale lockfile whose port has since been rebound by an
 *      unrelated process.
 *
 * Any failure at any step returns null (never throws) so callers can
 * unconditionally fail open to a direct file write.
 */

import { canonicalRepoRoot, readHubLockfile, type HubDescriptor } from './lockfile';
import { resolveHubRepoRoot } from './hubRepoRoot';

export interface DiscoverHubOptions {
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Health-check timeout in ms. Kept short — discovery must never stall a mutation. */
  timeoutMs?: number;
}

interface HubHealthBody {
  ok?: boolean;
  repoRoot?: string;
  pid?: number;
}

/** Exported for reuse by mutationClaim.ts's stale-claim liveness check (td-034). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process -> dead. EPERM: process exists but is owned by
    // someone else -> still alive. Any other error: treat as dead (safe default).
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export async function discoverHub(repoRoot: string, opts: DiscoverHubOptions = {}): Promise<HubDescriptor | null> {
  const descriptor = readHubLockfile(repoRoot);
  if (!descriptor) return null;

  const callerRoot = canonicalRepoRoot(resolveHubRepoRoot(repoRoot) ?? repoRoot);
  if (descriptor.repoRoot !== callerRoot) return null;

  if (!isProcessAlive(descriptor.pid)) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 400;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${descriptor.port}/api/hub/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as HubHealthBody;
    if (body.repoRoot !== callerRoot) return null;
    if (body.pid !== descriptor.pid) return null;
    return descriptor;
  } catch {
    return null;
  }
}
