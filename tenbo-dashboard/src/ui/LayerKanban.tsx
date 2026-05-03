import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { KanbanColumn } from './KanbanColumn';
import type { Item, Layer, Status } from '../types';
import { effectiveStatus } from '../api/lib/phases';
import styles from './LayerKanban.module.css';

interface Props {
  layer: Layer;
  items: Item[];
  depth?: number;
  /** When true, hides the collapse header and always shows the board (e.g. single-layer filter). */
  alwaysOpen?: boolean;
  onCardClick: (item: Item) => void;
  onTitleEdit: (id: string, title: string) => void;
  onDescEdit: (id: string, desc: string) => void;
}

const STATUSES: Status[] = ['now', 'next', 'later', 'done'];

export function LayerKanban({ layer, items, depth = 0, alwaysOpen = false, onCardClick, onTitleEdit, onDescEdit }: Props) {
  const counts = STATUSES.map(s => items.filter(i => effectiveStatus(i) === s).length);
  const hasActive = counts[0] > 0 || counts[1] > 0;
  const [open, setOpen] = useState(hasActive);

  const isOpen = alwaysOpen || open;

  return (
    <div className={styles.wrap} style={{ marginLeft: depth * 24 }}>
      {!alwaysOpen && (
        <div
          className={`${styles.header} ${isOpen ? styles.headerOpen : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => setOpen(o => !o)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }}
        >
          <span className={styles.toggle} aria-hidden="true">
            {isOpen ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronRight size={14} strokeWidth={1.75} />}
          </span>
          <span className={styles.name}>{layer.name}</span>
          <span className={styles.counts}>
            {counts[0]} · {counts[1]} · {counts[2]} · {counts[3]}
          </span>
        </div>
      )}
      {isOpen && (
        <div className={styles.body}>
          {STATUSES.map(status => (
            <KanbanColumn
              key={status}
              layerId={layer.id}
              status={status}
              items={items.filter(i => effectiveStatus(i) === status)}
              onCardClick={onCardClick}
              onTitleEdit={onTitleEdit}
              onDescEdit={onDescEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}
