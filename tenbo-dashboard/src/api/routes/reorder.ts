import type { Connect } from 'vite';
import { reorderItems } from '../lib/tenboFs';
import { readBody, json, error, withErrorHandling } from '../lib/http';

export function reorderRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.method !== 'POST' || req.url !== '/api/items/reorder') return next();
    const { scope, ids } = await readBody<{ scope?: string; ids?: unknown }>(req);
    if (!scope || !Array.isArray(ids)) {
      return error(res, 400, 'scope and ids required');
    }
    reorderItems(repoRoot, scope, ids as string[]);
    json(res, { ok: true });
  });
}
