import type { Connect } from 'vite';
import { readBody, json, withErrorHandling } from '../lib/http';
import { isRoadmapStoreError } from '../lib/roadmapStore';
import { enqueueMutation } from '../lib/hub/mutationQueue';
import { applyMutation, type ApplyMutationOptions, type MutationRequest } from '../lib/hub/mutations';
import { HUB_CLAIM_MAX_WAIT_MS, HUB_CLAIM_POLL_INTERVAL_MS } from '../lib/hub/mutationClaim';

/**
 * POST /api/hub/mutate — the hub's single write gateway for item mutations.
 *
 * Every request is run through `enqueueMutation` so concurrent callers
 * (routed here after `discoverHub` finds this server) apply strictly in
 * arrival order — see mutationQueue.ts for why that's the core value of the
 * hub. Errors are reported in the same `{ok:false,error,message,retryable}`
 * envelope the direct-write fallback already produces, so callers don't
 * need a hub-specific error-handling branch.
 */
// Hub-specific td-034 claim budget: much smaller than the CLI fallback's
// default (~1s), because this server process cannot afford to block its
// event loop — see HUB_CLAIM_MAX_WAIT_MS's doc comment in mutationClaim.ts.
const HUB_CLAIM_OPTIONS: ApplyMutationOptions = {
  claim: { maxWaitMs: HUB_CLAIM_MAX_WAIT_MS, pollIntervalMs: HUB_CLAIM_POLL_INTERVAL_MS },
};

export function hubMutateRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.url !== '/api/hub/mutate' || req.method !== 'POST') return next();
    const body = await readBody<MutationRequest>(req);

    try {
      const result = await enqueueMutation(() => applyMutation(repoRoot, body, HUB_CLAIM_OPTIONS));
      json(res, { ok: true, scope: result.scopeId, item: result.item, validation: result.validation });
    } catch (err) {
      if (isRoadmapStoreError(err)) {
        const status = err.code === 'not_found' ? 404 : 400;
        json(res, { ok: false, error: err.code, message: err.message, retryable: err.retryable }, status);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      json(res, { ok: false, error: 'error', message, retryable: false }, 500);
    }
  });
}
