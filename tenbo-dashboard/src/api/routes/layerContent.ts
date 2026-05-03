import type { Connect } from 'vite';
import { readLayerContent } from '../lib/tenboFs';
import { json, error } from '../lib/http';

export function layerContentRoute(repoRoot: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/layer-content')) return next();
    const url = new URL(req.url, 'http://localhost');
    const scope = url.searchParams.get('scope');
    const layer = url.searchParams.get('layer');
    if (!scope || !layer) {
      error(res, 400, 'scope and layer query parameters are required');
      return;
    }
    try {
      const content = readLayerContent(repoRoot, scope, layer);
      json(res, content);
    } catch (err) {
      error(res, 500, String(err));
    }
  };
}
