import type { Connect } from 'vite';
import { readState, archiveItems } from '../lib/tenboFs';
import { readBody, json, withErrorHandling } from '../lib/http';
import type { Item } from '../../types';

interface ArchiveRequest {
  scopeId?: string;
  days?: number;
  maxThreshold?: number;
}

interface ArchiveResultEntry {
  archived: string[];
  scopeId: string;
}

function isOlderThanDays(docUpdate: string | undefined, days: number): boolean {
  if (!docUpdate) return false;
  const match = docUpdate.match(/^\d{4}-\d{2}-\d{2}$/);
  if (!match) return false;
  const itemDate = new Date(docUpdate);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return itemDate <= cutoff;
}

function getArchivableIds(items: Item[], days: number, maxThreshold: number): string[] {
  const doneDropped = items.filter(i => i.status === 'done' || i.status === 'dropped');
  if (doneDropped.length <= maxThreshold) return [];
  return doneDropped
    .filter(i => isOlderThanDays(i.doc_update, days))
    .map(i => i.id);
}

export function archiveRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling(async (req, res, next) => {
    if (req.url !== '/api/archive' || req.method !== 'POST') return next();

    const body = await readBody<ArchiveRequest>(req);
    const days = body.days ?? 30;
    const maxThreshold = body.maxThreshold ?? 20;

    const state = readState(repoRoot);
    const results: ArchiveResultEntry[] = [];

    const scopesToProcess = body.scopeId
      ? state.scopes.filter(s => s.id === body.scopeId)
      : state.scopes;

    for (const scope of scopesToProcess) {
      const ids = getArchivableIds(scope.items, days, maxThreshold);
      if (ids.length > 0) {
        archiveItems(repoRoot, scope.id, ids);
        results.push({ archived: ids, scopeId: scope.id });
      }
    }

    json(res, results);
  });
}
