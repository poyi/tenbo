/**
 * recentWrites.ts — short-lived registry of writes the server just made,
 * keyed by absolute file path with their originating client token.
 *
 * Used for SSE echo suppression (td-005): when a chokidar event fires for
 * a path the server just wrote, the watch route checks this registry; if
 * the path matches a recent write, the SSE payload includes the originating
 * client's token. Clients then filter out events carrying their own token,
 * since they've already merged the change locally from the PATCH response.
 *
 * Entries auto-expire after RECENT_WRITE_TTL_MS to bound memory and avoid
 * stale matches against later external writes to the same path.
 */

const RECENT_WRITE_TTL_MS = 1000;

interface RecentWrite {
  origin: string | null;
  ts: number;
}

const recent = new Map<string, RecentWrite>();

/** Record a write to `absPath` originating from `origin` (null = unknown source). */
export function recordRecentWrite(absPath: string, origin: string | null): void {
  recent.set(absPath, { origin, ts: Date.now() });
  // Schedule cleanup so the map doesn't grow unbounded across a long session.
  setTimeout(() => {
    const cur = recent.get(absPath);
    if (cur && Date.now() - cur.ts >= RECENT_WRITE_TTL_MS) {
      recent.delete(absPath);
    }
  }, RECENT_WRITE_TTL_MS + 50);
}

/**
 * If `absPath` was written within the TTL window by a known origin, return
 * that origin token. Otherwise null (treat as external/unknown change).
 */
export function getRecentOrigin(absPath: string): string | null {
  const cur = recent.get(absPath);
  if (!cur) return null;
  if (Date.now() - cur.ts >= RECENT_WRITE_TTL_MS) {
    recent.delete(absPath);
    return null;
  }
  return cur.origin;
}
