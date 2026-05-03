import type { Connect } from 'vite';
import { readState, readWorkspace, tenboExists } from '../lib/tenboFs';
import { ensureFresh } from '../lib/metricsRefresh';
import { json, error, withErrorHandling } from '../lib/http';

export function stateRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.method !== 'GET' || req.url !== '/api/state') return next();
    if (!tenboExists(repoRoot)) {
      return error(res, 404, 'no .tenbo/ found at repo root');
    }
    const { scopeRefs } = readWorkspace(repoRoot);
    for (const ref of scopeRefs) {
      try {
        await ensureFresh(repoRoot, ref.id);
      } catch (e) {
        console.warn(`tenbo: metric refresh failed for scope ${ref.id}:`, e);
      }
    }
    const state = readState(repoRoot);
    json(res, state);
  });
}
