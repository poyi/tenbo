import { CornerLeftUp, ArrowLeftRight } from 'lucide-react';
import type { Item, Status } from '../types';
import { effectiveStatus } from '../api/lib/phases';
import { comparePriority } from '../api/lib/priority';
import styles from './TaskList.module.css';

export interface FlatItem {
  item: Item;
  scopeId: string;
  layerName?: string;
}

interface Props {
  items: FlatItem[];
  onRowClick: (scopeId: string, item: Item) => void;
}

const STATUS_ORDER: Status[] = ['now', 'next', 'later', 'done'];
const STATUS_LABEL: Record<Status, string> = { now: 'Now', next: 'Next', later: 'Later', done: 'Done', dropped: 'Dropped' };

export function TaskList({ items: rawItems, onRowClick }: Props) {
  // Hide `dropped` items from the list view (matches LayerKanban behavior).
  const items = rawItems.filter(({ item }) => effectiveStatus(item) !== 'dropped');
  // Group by status (now → next → later → done) and within each status
  // group by priority (p0 → p3 → unset). Both sorts are stable so file
  // order acts as the tiebreaker for items at the same priority. (td-009)
  const sorted = STATUS_ORDER.flatMap(s =>
    items
      .filter(({ item }) => effectiveStatus(item) === s)
      .sort((a, b) => comparePriority(a.item, b.item))
  );

  if (items.length === 0) {
    return <div className={styles.empty}>No items to show.</div>;
  }

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.thStatus}>Status</th>
            <th className={styles.thId}>ID</th>
            <th className={styles.thPriority}>Priority</th>
            <th className={styles.thTitle}>Title</th>
            <th className={styles.thLayer}>Layer</th>
            <th className={styles.thType}>Type</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ item, scopeId, layerName }) => {
            const status = effectiveStatus(item);
            return (
              <tr
                key={item.id}
                className={styles.row}
                onClick={() => onRowClick(scopeId, item)}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(scopeId, item); } }}
              >
                <td>
                  <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
                    {STATUS_LABEL[status]}
                  </span>
                </td>
                <td>
                  <div className={styles.tdId}>
                    <span className={styles.idText}>{item.id}</span>
                    {item.spawned_from && (
                      <span className={styles.relChip} title={`Spawned from ${item.spawned_from}`}>
                        <CornerLeftUp size={10} strokeWidth={1.75} />
                      </span>
                    )}
                    {item.related && item.related.length > 0 && (
                      <span className={styles.relChip} title={`Related to ${item.related.length} item(s)`}>
                        <ArrowLeftRight size={10} strokeWidth={1.75} /> {item.related.length}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  {item.priority
                    ? <span className={`${styles.priority} ${styles[`pri_${item.priority}`]}`}>{item.priority.toUpperCase()}</span>
                    : <span className={styles.dash}>—</span>
                  }
                </td>
                <td>
                  <span className={styles.titleText}>{item.title}</span>
                </td>
                <td className={styles.tdLayer}>{layerName ?? item.layer ?? <span className={styles.dash}>—</span>}</td>
                <td className={styles.tdType}>{item.type ?? <span className={styles.dash}>—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
