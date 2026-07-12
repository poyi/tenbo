/**
 * client.ts — HTTP client for a discovered hub's mutation endpoint.
 *
 * Thin wrapper: POSTs a `MutationRequest` to `/api/hub/mutate` and either
 * returns the hub-applied `WriteResult` or throws. The caller (scripts/item.ts)
 * treats ANY thrown error here — network failure, timeout, or a well-formed
 * `{ok:false}` error body — as "the hub didn't apply this" and falls back to
 * a direct write. This file does not decide fallback policy; it only talks HTTP.
 */

import { RoadmapStoreError, type RoadmapErrorCode, type WriteResult } from '../roadmapStore';
import type { HubDescriptor } from './lockfile';
import type { MutationRequest } from './mutations';

export interface SendHubMutationOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface HubMutateSuccessBody {
  ok: true;
  scope: string;
  item: WriteResult['item'];
  validation: WriteResult['validation'];
}

interface HubMutateErrorBody {
  ok: false;
  error: string;
  message: string;
  retryable?: boolean;
}

export async function sendHubMutation(
  hub: HubDescriptor,
  req: MutationRequest,
  opts: SendHubMutationOptions = {},
): Promise<WriteResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`http://127.0.0.1:${hub.port}/api/hub/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
  });
  const body = (await res.json()) as HubMutateSuccessBody | HubMutateErrorBody;
  if (!res.ok || body.ok === false) {
    const err = body as HubMutateErrorBody;
    throw new RoadmapStoreError(
      (err.error as RoadmapErrorCode) ?? 'error',
      err.message ?? `hub mutation failed (HTTP ${res.status})`,
      err.retryable ?? false,
    );
  }
  const ok = body as HubMutateSuccessBody;
  return { scopeId: ok.scope, filePath: '', item: ok.item, validation: ok.validation };
}
