import type { Finding } from '../../api/lib/health/types';
import type { LayerMetrics } from '../../types';
import { Check } from 'lucide-react';
import { SeverityIcon } from './SeverityIcon';
import styles from './HealthPage.module.css';

interface Props {
  scopeId: string;
  layerId: string;
  layerName: string;
  metrics: LayerMetrics;
  findings: Finding[];
  onSelect: () => void;
}

export function LayerCard({ layerName, metrics, findings, onSelect }: Props) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return (
    <button type="button" className={styles.layerCard} onClick={onSelect}>
      <h3 className={styles.layerCardTitle}>{layerName}</h3>
      <div className={styles.layerCardStats}>
        <span>{metrics.file_count.toLocaleString()} files</span>
        <span>·</span>
        <span>{metrics.total_lines.toLocaleString()} LOC</span>
      </div>
      <div className={styles.layerCardCounts}>
        {counts.critical > 0 && <span className={styles.severityChip}><SeverityIcon severity="critical" /> {counts.critical}</span>}
        {counts.warning > 0 && <span className={styles.severityChip}><SeverityIcon severity="warning" /> {counts.warning}</span>}
        {counts.info > 0 && <span className={styles.severityChip}><SeverityIcon severity="info" /> {counts.info}</span>}
        {counts.critical === 0 && counts.warning === 0 && counts.info === 0 && <span className={styles.severityChip}><Check size={14} strokeWidth={2} color="var(--success, #48bb78)" aria-label="healthy" /></span>}
      </div>
      <span className={styles.layerCardLink}>drill in →</span>
    </button>
  );
}
