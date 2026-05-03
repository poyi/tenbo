import { useEffect, useState } from 'react';
import type { LayerContent } from '../types';

export function useLayerContent(
  scopeId: string,
  layerId: string,
  generation: number,
): { content: LayerContent | null; error: string | null } {
  const [content, setContent] = useState<LayerContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(`/api/layer-content?scope=${encodeURIComponent(scopeId)}&layer=${encodeURIComponent(layerId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`GET /api/layer-content -> ${r.status}`);
        return r.json();
      })
      .then((c) => { if (!cancelled) setContent(c); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [scopeId, layerId, generation]);
  return { content, error };
}
