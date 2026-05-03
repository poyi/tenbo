import { useEffect, useState } from 'react';
import { tenboApi } from '../../../api/client';
import type { LayerDoc } from '../../../types';

export function DeepDivesTab({ scopeId, layerId }: { scopeId: string; layerId: string }) {
  const [docs, setDocs] = useState<LayerDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    tenboApi.getLayerDocs(scopeId, layerId)
      .then((d) => { if (!cancelled) { setDocs(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setDocs([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [scopeId, layerId]);

  if (loading) return <div>Loading…</div>;
  if (docs.length === 0) return <p>No deep-dive docs found for this layer.</p>;

  return (
    <ul>
      {docs.map((d) => (
        <li key={d.filename}>
          <button
            className="link-button"
            onClick={() => tenboApi.openFile(`.tenbo/scopes/${scopeId}/layers/${layerId}/${d.filename}`).catch(() => {})}
          >
            {d.title || d.filename}
          </button>
        </li>
      ))}
    </ul>
  );
}
