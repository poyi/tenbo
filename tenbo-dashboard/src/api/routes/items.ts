import type { Connect } from 'vite';
import path from 'node:path';
import { patchItem, readState } from '../lib/tenboFs';
import { recordRecentWrite } from '../lib/recentWrites';
import { readBody, json, error, withErrorHandling } from '../lib/http';

const ALLOWED = new Set(['title', 'description', 'status', 'layer', 'notes', 'links', 'priority', 'done_when', 'files_to_read', 'risks', 'phases']);

export function itemsRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    const m = req.url?.match(/^\/api\/items\/([^/?]+)(\?.*)?$/);
    if (!m || req.method !== 'PATCH') return next();
    const itemId = m[1];
    const body = await readBody<{ scope?: string; patch?: Record<string, unknown> }>(req);
    const scopeId = body.scope;
    const patch = body.patch;
    if (!scopeId || !patch) {
      return error(res, 400, 'scope and patch required');
    }
    const filtered: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) {
      if (ALLOWED.has(k)) filtered[k] = patch[k];
    }

    // Record the originating client token so the SSE channel can suppress
    // the echo back to that client (td-005 step 3 — echo suppression).
    // Clients send X-Tenbo-Origin as a per-instance UUID generated at boot.
    const origin = (req.headers['x-tenbo-origin'] as string | undefined) ?? null;
    const filePath = path.join(repoRoot, '.tenbo', 'scopes', scopeId, 'roadmap.yaml');
    recordRecentWrite(filePath, origin);

    patchItem(repoRoot, scopeId, itemId, filtered);

    // Re-read state and return the canonical post-write item so the client
    // can merge into its local state immediately (td-005 step 1+2 —
    // optimistic UI without waiting for SSE). Falls through to a 404 if
    // the item somehow disappeared during the write (concurrent delete).
    const state = readState(repoRoot);
    const scope = state.scopes.find((s) => s.id === scopeId);
    const item = scope?.items.find((i) => i.id === itemId);
    if (!item) {
      return error(res, 404, `item ${itemId} not found in scope ${scopeId} after patch`);
    }
    json(res, { ok: true, item });
  });
}
