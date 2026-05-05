import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CornerLeftUp, ArrowLeftRight } from 'lucide-react';
import type { Item } from '../types';
import { effectiveStatus, phaseProgress } from '../api/lib/phases';
import styles from './ItemCard.module.css';

interface Props {
  item: Item;
  onClick: () => void;
  onTitleEdit: (newTitle: string) => void;
  onDescEdit: (newDesc: string) => void;
}

export function ItemCard({ item, onClick, onTitleEdit, onDescEdit }: Props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const dragStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const [editing, setEditing] = useState<null | 'title' | 'desc'>(null);
  const phases = item.phases ?? [];
  const progress = phases.length > 0 ? phaseProgress(phases) : null;

  // Done cards are dimmed in the kanban so the live columns (now/next/later)
  // own the user's visual attention. Hover restores opacity. The item modal
  // (rendered separately) is not affected — only the kanban card. (td-008)
  const isDone = effectiveStatus(item) === 'done';

  return (
    <div
      ref={setNodeRef}
      className={`${styles.card}${isDone ? ` ${styles.cardDone}` : ''}`}
      style={dragStyle}
      {...attributes}
      {...listeners}
      onClick={() => { if (!editing) onClick(); }}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'Enter') { e.preventDefault(); onClick(); }
        // Space is consumed by dnd-kit for drag-pickup; don't intercept it.
      }}
    >
      <div className={styles.id}>
        {item.priority && <span className={`${styles.priority} ${styles[item.priority]}`}>{item.priority.toUpperCase()}</span>}
        {item.id}
        {item.spawned_from && (
          <span
            className={styles.relChip}
            title={`Spawned from ${item.spawned_from}`}
            aria-label={`Spawned from ${item.spawned_from}`}
          >
            <CornerLeftUp size={11} strokeWidth={1.75} /> {item.spawned_from}
          </span>
        )}
        {item.related && item.related.length > 0 && (
          <span
            className={styles.relChip}
            title={`Related to ${item.related.length} item${item.related.length === 1 ? '' : 's'}`}
            aria-label={`Related to ${item.related.length} items`}
          >
            <ArrowLeftRight size={11} strokeWidth={1.75} /> {item.related.length}
          </span>
        )}
      </div>

      {editing === 'title' ? (
        <input
          autoFocus
          defaultValue={item.title}
          onBlur={(e) => { setEditing(null); if (e.target.value !== item.title) onTitleEdit(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }}
          onClick={(e) => e.stopPropagation()}
          className={styles.titleInput}
        />
      ) : (
        <div
          onDoubleClick={(e) => { e.stopPropagation(); setEditing('title'); }}
          className={styles.title}
          title={item.title}
        >
          {item.title}
        </div>
      )}

      {editing === 'desc' ? (
        <textarea
          autoFocus
          defaultValue={item.description}
          onBlur={(e) => { setEditing(null); if (e.target.value !== item.description) onDescEdit(e.target.value); }}
          onClick={(e) => e.stopPropagation()}
          className={styles.descInput}
        />
      ) : (
        <div
          onDoubleClick={(e) => { e.stopPropagation(); setEditing('desc'); }}
          className={styles.desc}
        >
          {item.description}
        </div>
      )}

      {progress && (
        <div
          className={styles.phaseProgress}
          title={`${progress.done} of ${progress.total} phases complete${progress.active ? ` · active: ${progress.active.title}` : ''}`}
          aria-label={`Phase progress: ${progress.done} of ${progress.total} done`}
        >
          <span className={styles.phaseChip}>{progress.done}/{progress.total}</span>
          <span className={styles.phaseBar} aria-hidden="true">
            <span
              className={styles.phaseBarFill}
              style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '0%' }}
            />
          </span>
        </div>
      )}
    </div>
  );
}
