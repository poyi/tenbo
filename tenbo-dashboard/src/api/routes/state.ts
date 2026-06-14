import type { Connect } from 'vite';
import { readState, tenboExists } from '../lib/tenboFs';
import { metricsStatusForScopes } from '../lib/metricsRefreshQueue';
import { json, error, withErrorHandling } from '../lib/http';

export function stateRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.method !== 'GET' || req.url !== '/api/state') return next();
    if (!tenboExists(repoRoot)) {
      return error(res, 404, 'no .tenbo/ found at repo root');
    }
    const state = readState(repoRoot);
    state.metricsStatus = metricsStatusForScopes(repoRoot, state.scopes, state.metrics);
    json(res, state);
  });
}
