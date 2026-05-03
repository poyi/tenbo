import type { TenboState, RelatedDoc, Item, LayerDoc } from '../types';

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const tenboApi = {
  getState(): Promise<TenboState> {
    return http('/api/state');
  },
  getRelated(): Promise<RelatedDoc[]> {
    return http('/api/related');
  },
  patchItem(scopeId: string, itemId: string, patch: Partial<Item>): Promise<{ ok: true }> {
    return http(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scopeId, patch }),
    });
  },
  reorder(scopeId: string, ids: string[]): Promise<{ ok: true }> {
    return http('/api/items/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: scopeId, ids }),
    });
  },
  getLayerDocs(scopeId: string, layerId: string): Promise<LayerDoc[]> {
    const params = new URLSearchParams({ scope: scopeId, layer: layerId });
    return http(`/api/layer-docs?${params}`);
  },
  openFile(path: string): Promise<{ ok: true }> {
    return http('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },
};
