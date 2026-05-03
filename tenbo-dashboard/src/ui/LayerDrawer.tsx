import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { tenboApi } from '../api/client';
import type { Layer, LayerDoc } from '../types';
import styles from './LayerDrawer.module.css';

interface Props {
  scopeId: string;
  layer: Layer | null;
  narrative: string | null;
  onClose: () => void;
}

export function LayerDrawer({ scopeId, layer, narrative, onClose }: Props) {
  const [docs, setDocs] = useState<LayerDoc[]>([]);
  const layerId = layer?.id;
  useEffect(() => {
    if (!layerId) return;
    tenboApi.getLayerDocs(scopeId, layerId).then(setDocs).catch(() => setDocs([]));
  }, [scopeId, layerId]);

  if (!layer) return null;
  return (
    <>
      <div onClick={onClose} className={`dim-backdrop ${styles.backdrop}`} />
      <aside className={styles.drawer}>
        <button onClick={onClose} className="close-x" aria-label="Close">
          <X size={18} strokeWidth={1.75} />
        </button>
        <h2 className={styles.title}>{layer.name}</h2>
        <p className={styles.subtitle}>{layer.description}</p>
        {narrative ? (
          <div className={styles.narrative}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{narrative}</ReactMarkdown>
          </div>
        ) : <p className={styles.missing}>No narrative file found.</p>}

        {docs.length > 0 && (
          <>
            <hr />
            <h3 className={styles.deepDivesHeading}>Deep dives</h3>
            <ul className={styles.deepDivesList}>
              {docs.map(d => (
                <li key={d.filename}>
                  <button
                    className="link-button"
                    onClick={() => tenboApi.openFile(`.tenbo/scopes/${scopeId}/layers/${layer.id}/${d.filename}`)}
                  >
                    {d.title || d.filename}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <hr />
        <details>
          <summary className={styles.filesSummary}>Files (for the agent)</summary>
          <ul className={styles.filesList}>
            {layer.files.map(f => <li key={f}><code>{f}</code></li>)}
          </ul>
        </details>
      </aside>
    </>
  );
}
