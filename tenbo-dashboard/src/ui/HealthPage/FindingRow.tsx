import type { Finding } from '../../api/lib/health/types';
import { SeverityIcon } from './SeverityIcon';
import styles from './HealthPage.module.css';

interface Props {
  finding: Finding;
  onClick: (finding: Finding) => void;
  showLayer?: boolean;
}

export function FindingRow({ finding, onClick, showLayer = true }: Props) {
  return (
    <button type="button" className={styles.findingRow} onClick={() => onClick(finding)}>
      <span className={styles.findingSev}><SeverityIcon severity={finding.severity} /></span>
      <span className={styles.findingSignal}>{finding.signal}</span>
      {showLayer && <span className={styles.findingLayer}>· {finding.layer}</span>}
      <span className={styles.findingHeadline}>{finding.headline}</span>
      <span className={styles.findingSuggestion}>→ {finding.suggestion.summary}</span>
    </button>
  );
}
