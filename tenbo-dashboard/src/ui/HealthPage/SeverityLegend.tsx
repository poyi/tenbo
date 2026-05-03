import { SeverityIcon } from './SeverityIcon';
import styles from './HealthPage.module.css';

interface Props {
  counts: { critical: number; warning: number; info: number };
  /** When true (default), severity tiers with a count of 0 are still shown so the legend reads as a key. */
  showZero?: boolean;
}

export function SeverityLegend({ counts, showZero = true }: Props) {
  const items: Array<{ severity: 'critical' | 'warning' | 'info'; count: number; label: string }> = [
    { severity: 'critical', count: counts.critical, label: 'critical' },
    { severity: 'warning', count: counts.warning, label: 'warning' },
    { severity: 'info', count: counts.info, label: 'info' },
  ];
  return (
    <span className={styles.severityLegend}>
      {items.filter(i => showZero || i.count > 0).map(({ severity, count, label }) => (
        <span key={severity} className={styles.severityLegendItem}>
          <SeverityIcon severity={severity} />
          <span className={styles.severityLegendCount}>{count}</span>
          <span className={styles.severityLegendLabel}>{label}</span>
        </span>
      ))}
    </span>
  );
}
