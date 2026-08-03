import type { Connect } from 'vite';
import { LocalTenboBackend } from '../backends/LocalTenboBackend';
import { type CommandEnvelopeDto, TenboContractError, type QueryEnvelopeDto } from '../../contracts/tenbo';
import { readBody, json, withErrorHandling } from '../lib/http';
import { enqueueMutation } from '../lib/hub/mutationQueue';
import { isRoadmapStoreError } from '../lib/roadmapStore';

function statusFor(error: unknown): number {
  if (error instanceof TenboContractError) {
    if (error.code === 'not_found') return 404;
    if (error.code === 'conflict') return 409;
    if (error.code === 'permission_denied') return 403;
    return 400;
  }
  if (isRoadmapStoreError(error)) return error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
  return 500;
}

function failure(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof TenboContractError || isRoadmapStoreError(error) ? error.code : 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function tenboQueryRoute(repoRoot: string): Connect.NextHandleFunction {
  const backend = new LocalTenboBackend(repoRoot);
  return withErrorHandling(async (req, res, next) => {
    if (req.url !== '/api/tenbo/query' || req.method !== 'POST') return next();
    try {
      json(res, await backend.query(await readBody<QueryEnvelopeDto>(req)));
    } catch (error) {
      json(res, failure(error), statusFor(error));
    }
  });
}

export function tenboCommandRoute(repoRoot: string, route = '/api/tenbo/command'): Connect.NextHandleFunction {
  const backend = new LocalTenboBackend(repoRoot);
  return withErrorHandling(async (req, res, next) => {
    if (req.url !== route || req.method !== 'POST') return next();
    try {
      const request = await readBody<CommandEnvelopeDto>(req);
      json(res, await enqueueMutation(() => backend.command(request)));
    } catch (error) {
      json(res, failure(error), statusFor(error));
    }
  });
}
