import { useEffect, useState, useCallback, useRef } from 'react';
import type { TenboState } from '../types';
import { tenboApi } from '../api/client';

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

  useEffect(() => { reload(); }, [reload]);

  // SSE: debounced reload on any file change
  useEffect(() => {
    const es = new EventSource('/api/watch');
    es.onmessage = () => {
      if (reloadDebounce.current) window.clearTimeout(reloadDebounce.current);
      reloadDebounce.current = window.setTimeout(() => { reload(); }, 250);
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => es.close();
  }, [reload]);

  return { state, loadError, reload, generation };
}
