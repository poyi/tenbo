import type { Connect } from 'vite';
import { error, json, readBody, withErrorHandling } from '../lib/http';
import { readWorkspace, tenboExists } from '../lib/tenboFs';
import { metricsStatusForScope, requestMetricsRefresh } from '../lib/metricsRefreshQueue';

interface RefreshMetricsBody {
  scopeId?: string;
  force?: boolean;
}

export function refreshMetricsRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.method !== 'POST' || req.url !== '/api/refresh-metrics') return next();
    if (!tenboExists(repoRoot)) {
      return error(res, 404, 'no .tenbo/ found at repo root');
    }

    const body = await readBody<RefreshMetricsBody>(req);
    const { scopeRefs } = readWorkspace(repoRoot);
    const targets = body.scopeId
      ? scopeRefs.filter((scope) => scope.id === body.scopeId)
      : scopeRefs;

    if (body.scopeId && targets.length === 0) {
      return error(res, 404, `unknown scope: ${body.scopeId}`);
    }

    for (const scope of targets) {
      void requestMetricsRefresh(repoRoot, scope.id, {
        force: body.force ?? true,
        reason: 'Health metrics refresh requested.',
      });
    }

    const metricsStatus = Object.fromEntries(
      targets.map((scope) => [scope.id, metricsStatusForScope(repoRoot, scope.id, undefined)]),
    );
    json(res, { metricsStatus }, 202);
  });
}
