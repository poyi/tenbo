import type { TenboState, RelatedDoc, Item, LayerDoc } from '../types';

/**
 * Per-instance origin token. Sent with every PATCH so the server can attach it
 * to the resulting SSE echo, which the SSE handler in useTenboState filters out
 * (we already merged the change locally from the PATCH response — no need to
 * trigger a redundant full reload). See td-005.
 */
export const TENBO_ORIGIN = (() => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `o-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
})();

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
  patchItem(scopeId: string, itemId: string, patch: Partial<Item>): Promise<{ ok: true; item: Item }> {
    return http(`/api/items/${itemId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenbo-Origin': TENBO_ORIGIN,
      },
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
