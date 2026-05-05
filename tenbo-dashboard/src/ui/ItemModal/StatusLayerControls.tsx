import type { Layer, Priority, Status } from '../../types';
import styles from './ItemModal.module.css';

const STATUSES: Status[] = ['now', 'next', 'later', 'done', 'dropped'];
const PRIORITIES: Priority[] = ['p0', 'p1', 'p2', 'p3'];

interface Props {
  status: Status;
  layer: string;
  layers: Layer[];
  priority?: Priority;
  statusDisabled?: boolean;
  onStatusChange: (s: Status) => void;
  onLayerChange: (l: string) => void;
  onPriorityChange: (p: Priority | undefined) => void;
}

export function StatusLayerControls({ status, layer, layers, priority, statusDisabled, onStatusChange, onLayerChange, onPriorityChange }: Props) {
  return (
    <div className={styles.controls}>
      <label className={styles.controlLabel}>Status:
        <select value={status} onChange={e => onStatusChange(e.target.value as Status)} className={styles.controlSelect} disabled={statusDisabled} title={statusDisabled ? 'Derived from phases' : undefined}>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <label className={styles.controlLabel}>Layer:
        <select value={layer} onChange={e => onLayerChange(e.target.value)} className={styles.controlSelect}>
          {layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <label className={styles.controlLabel}>Priority:
        <select
          value={priority ?? ''}
          onChange={e => onPriorityChange(e.target.value === '' ? undefined : (e.target.value as Priority))}
          className={styles.controlSelect}
        >
          <option value="">unset</option>
          {PRIORITIES.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
        </select>
      </label>
    </div>
  );
}
