import type { Finding, Signal } from '../../api/lib/health/types';
import { sortFindings } from './severity';
import { FindingRow } from './FindingRow';
import styles from './HealthPage.module.css';

interface Props {
  findings: Finding[];
  signalWeights: readonly Signal[];
  onSelect: (finding: Finding) => void;
  limit?: number;
}

export function Digest({ findings, signalWeights, onSelect, limit = 10 }: Props) {
  const top = sortFindings(findings, signalWeights).slice(0, limit);
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Top findings</h2>
      {top.length === 0 ? (
        <p className={styles.emptyState}>No findings — everything looks healthy.</p>
      ) : (
        <ul className={styles.findingList}>
          {top.map(f => (
            <li key={f.id}><FindingRow finding={f} onClick={onSelect} /></li>
          ))}
        </ul>
      )}
    </section>
  );
}
