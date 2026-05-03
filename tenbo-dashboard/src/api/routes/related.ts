import type { Connect } from 'vite';
import { scanForRelated } from '../lib/frontmatterScan';
import { json, withErrorHandling } from '../lib/http';

export function relatedRoute(repoRoot: string): Connect.NextHandleFunction {
  return withErrorHandling((req, res, next) => {
    if (req.method !== 'GET' || req.url !== '/api/related') return next();
    const docs = scanForRelated(repoRoot);
    json(res, docs);
  });
}
