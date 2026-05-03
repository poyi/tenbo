import type { Item } from '../types';
import { effectiveStatus } from '../api/lib/phases';
import styles from './SummaryStrip.module.css';

export function SummaryStrip({ items }: { items: Item[] }) {
  const counts = { now: 0, next: 0, later: 0, done: 0 };
  for (const i of items) counts[effectiveStatus(i)]++;
  return (
    <div className={styles.strip}>
      <span>Now: <strong className={styles.now}>{counts.now}</strong></span>
      <span>Next: <strong className={styles.next}>{counts.next}</strong></span>
      <span>Later: <strong>{counts.later}</strong></span>
      <span>Done: <strong className={styles.done}>{counts.done}</strong></span>
    </div>
  );
}
