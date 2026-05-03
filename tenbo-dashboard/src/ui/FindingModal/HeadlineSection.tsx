import type { Finding } from '../../api/lib/health/types';
import { SeverityIcon } from '../HealthPage/SeverityIcon';
import styles from './FindingModal.module.css';

export function HeadlineSection({ finding }: { finding: Finding }) {
  return (
    <div className={styles.headline}>
      <div className={styles.chips}>
        <span className={styles.chip}><SeverityIcon severity={finding.severity} /> {finding.severity}</span>
        <span className={styles.chip}>{finding.signal}</span>
        <span className={styles.chip}>{finding.layer}</span>
        <span className={styles.chip}>confidence: {finding.confidence}</span>
      </div>
      <h2 className={styles.title}>{finding.headline}</h2>
    </div>
  );
}
