import type { TenboState, RelatedDoc, Item, LayerDoc } from '../types';
import { BrowserTenboClient } from '../clients/BrowserTenboClient';
import { TENBO_SCHEMA_VERSION, type ItemRichPatchDto, type TenboCommand } from '../contracts/tenbo';

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

const contractClient = new BrowserTenboClient();
let mutationCounter = 0;

async function command(value: TenboCommand) {
  mutationCounter += 1;
  return contractClient.command({
    schema_version: TENBO_SCHEMA_VERSION,
    mutation_id: `${TENBO_ORIGIN}-${mutationCounter}`,
    actor: { id: TENBO_ORIGIN, type: 'user' },
    command: value,
  });
}

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
    void scopeId;
    return (async () => {
      const { status, notes: _notes, verification: _verification, ...rich } = patch;
      void _notes;
      void _verification;
      let updated: Item | undefined;
      if (Object.keys(rich).length > 0) {
        const result = await command({ kind: 'updateRichFields', item_id: itemId, patch: rich as ItemRichPatchDto });
        if (result.kind !== 'item') throw new Error(`expected item result, received ${result.kind}`);
        updated = result.value.item;
      }
      if (status) {
        const result = await command({ kind: 'setStatus', item_id: itemId, status });
        if (result.kind !== 'item') throw new Error(`expected item result, received ${result.kind}`);
        updated = result.value.item;
      }
      if (!updated) throw new Error('item patch did not contain a supported field');
      return { ok: true as const, item: updated };
    })();
  },
  reorder(scopeId: string, ids: string[]): Promise<{ ok: true }> {
    return command({ kind: 'reorderItems', scope_id: scopeId, item_ids: ids }).then(() => ({ ok: true as const }));
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
