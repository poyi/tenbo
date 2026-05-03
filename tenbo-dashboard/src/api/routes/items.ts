import type { Connect } from 'vite';
import { patchItem } from '../lib/tenboFs';
import { readBody, json, error, withErrorHandling } from '../lib/http';

const ALLOWED = new Set(['title', 'description', 'status', 'layer', 'notes', 'links', 'priority', 'done_when', 'files_to_read', 'risks']);

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
    patchItem(repoRoot, scopeId, itemId, filtered);
    json(res, { ok: true });
  });
}
