import type { Connect } from 'vite';
import { listLayerDocs } from '../lib/tenboFs';
import { json, error } from '../lib/http';

export function layerDocsRoute(repoRoot: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/layer-docs')) return next();
    const url = new URL(req.url, 'http://localhost');
    const scopeId = url.searchParams.get('scope');
    const layerId = url.searchParams.get('layer');
    if (!scopeId || !layerId) {
      error(res, 400, 'scope and layer query params required');
      return;
    }
    try {
      const docs = listLayerDocs(repoRoot, scopeId, layerId);
      json(res, docs);
    } catch (err) {
      error(res, 500, String(err));
    }
  };
}
