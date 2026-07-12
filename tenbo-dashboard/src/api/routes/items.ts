import type { Connect } from 'vite';
import path from 'node:path';
import { patchItem, readState, PatchConflictError } from '../lib/tenboFs';
import { recordRecentWrite } from '../lib/recentWrites';
import { readBody, json, error, withErrorHandling } from '../lib/http';
import { enqueueMutation } from '../lib/hub/mutationQueue';
import type { Item } from '../../types';

const ALLOWED = new Set(['title', 'description', 'status', 'layer', 'notes', 'links', 'verification', 'priority', 'done_when', 'files_to_read', 'risks', 'phases']);

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

    // td-033: run the read-modify-write (and the post-write read-back below)
    // through the SAME process-wide queue the hub/CLI mutation path uses
    // (see hub/mutationQueue.ts, hub/hubMutate.ts). This makes the dashboard
    // server a genuine single serialized writer — a UI PATCH and a
    // concurrent hub mutation can no longer interleave their read/modify/write.
    // The post-write item lookup is done INSIDE the queued turn too, so the
    // response always reflects this write's own result, not a later queued
    // mutation's.
    let item: Item | undefined;
    try {
      item = await enqueueMutation(() => {
        patchItem(repoRoot, scopeId, itemId, filtered);
        const state = readState(repoRoot);
        const scope = state.scopes.find((s) => s.id === scopeId);
        return scope?.items.find((i) => i.id === itemId);
      });
    } catch (err) {
      if (err instanceof PatchConflictError) {
        return error(res, 409, err.message);
      }
      throw err;
    }

    // Falls through to a 404 if the item somehow disappeared during the
    // write (concurrent delete).
    if (!item) {
      return error(res, 404, `item ${itemId} not found in scope ${scopeId} after patch`);
    }
    json(res, { ok: true, item });
  });
}
