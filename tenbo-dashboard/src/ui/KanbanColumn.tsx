import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ItemCard } from './ItemCard';
import type { Item, Status } from '../types';
import styles from './KanbanColumn.module.css';

interface Props {
  layerId: string;
  status: Status;
  items: Item[];
  onCardClick: (item: Item) => void;
  onTitleEdit: (id: string, title: string) => void;
  onDescEdit: (id: string, desc: string) => void;
}

const LABEL: Record<Status, string> = { now: 'NOW', next: 'NEXT', later: 'LATER', done: 'DONE' };

export function KanbanColumn({ layerId, status, items, onCardClick, onTitleEdit, onDescEdit }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: `${layerId}::${status}`, data: { layerId, status } });
  return (
    <div ref={setNodeRef} className={`${styles.column} ${isOver ? styles.columnOver : ''}`}>
      <div className={styles.label}>{LABEL[status]}</div>
      <SortableContext items={items.map(i => i.id)} strategy={verticalListSortingStrategy}>
        {items.map(item => (
          <ItemCard
            key={item.id}
            item={item}
            onClick={() => onCardClick(item)}
            onTitleEdit={(t) => onTitleEdit(item.id, t)}
            onDescEdit={(d) => onDescEdit(item.id, d)}
          />
        ))}
      </SortableContext>
    </div>
  );
}
