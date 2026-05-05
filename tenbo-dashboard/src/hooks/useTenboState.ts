import { useEffect, useState, useCallback, useRef } from 'react';
import type { TenboState, Item } from '../types';
import { tenboApi, TENBO_ORIGIN } from '../api/client';

export function useTenboState() {
  const [state, setState] = useState<TenboState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [generation, setGeneration] = useState<number>(0);
  const reloadDebounce = useRef<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setState(await tenboApi.getState());
      setGeneration(n => n + 1);
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, []);

  /**
   * Merge a single canonical item into local state without a full reload.
   * Used after a PATCH response — the server has already written, returned
   * the canonical item shape, and our SSE handler will skip the echo for
   * this client's own origin token. The visible state updates within a
   * single React frame instead of waiting ~250ms for the SSE round-trip.
   * See td-005.
   */
  const mergeItem = useCallback((scopeId: string, item: Item) => {
    setState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        scopes: prev.scopes.map(s =>
          s.id !== scopeId
            ? s
            : { ...s, items: s.items.map(i => (i.id === item.id ? item : i)) },
        ),
      };
    });
    // Bump generation so memoized derivations invalidate (kanban groupings,
    // priority sort, etc.) just as they would after a full reload.
    setGeneration(n => n + 1);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  /**
   * Replace all items for a single scope without a full state reload.
   * Used when SSE delivers a `roadmap-change` event (td-006 — item-level
   * events) carrying the new items list. The rest of the state graph
   * (scopes, layers, narratives, metrics) is unchanged for roadmap edits,
   * so we don't refetch any of it.
   */
  const replaceScopeItems = useCallback((scopeId: string, items: Item[]) => {
    setState(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        scopes: prev.scopes.map(s =>
          s.id !== scopeId ? s : { ...s, items },
        ),
      };
    });
    setGeneration(n => n + 1);
  }, []);

  // SSE handler. Three event kinds, in increasing cost:
  //   - `roadmap-change`: replace one scope's items[]; no fetch.
  //   - `file-change` for non-roadmap files: debounced full reload (rare).
  //   - Echo of our own write (origin matches): ignored entirely.
  useEffect(() => {
    const es = new EventSource('/api/watch');
    es.onmessage = (e) => {
      let data: { kind?: string; scopeId?: string; items?: Item[]; origin?: string | null } | null = null;
      try {
        data = JSON.parse(e.data);
      } catch { /* malformed — fall through and reload as a safety net */ }

      if (data?.origin && data.origin === TENBO_ORIGIN) return; // own write — already merged

      if (data?.kind === 'roadmap-change' && data.scopeId && Array.isArray(data.items)) {
        replaceScopeItems(data.scopeId, data.items);
        return;
      }

      // file-change (non-roadmap) or unknown shape: fall back to debounced full reload.
      if (reloadDebounce.current) window.clearTimeout(reloadDebounce.current);
      reloadDebounce.current = window.setTimeout(() => { reload(); }, 250);
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
  }, [reload, replaceScopeItems]);

  return { state, loadError, reload, mergeItem, generation };
}
