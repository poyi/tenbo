import { useState } from 'react';
import type { Finding, Signal } from '../../api/lib/health/types';
import { FindingRow } from '../HealthPage/FindingRow';
import { sortFindings } from '../HealthPage/severity';
import styles from './LayerDetailPage.module.css';

interface Props {
  signal: Signal;
  signalLabel: string;
  findings: Finding[];
  onSelectFinding: (f: Finding) => void;
}

export function SignalSection({ signal, signalLabel, findings, onSelectFinding }: Props) {
  const [open, setOpen] = useState(findings.length > 0);
  const sorted = sortFindings(findings, [signal] as Signal[]);
  return (
    <section className={styles.signalSection}>
      <button type="button" className={styles.signalHeader} onClick={() => setOpen(!open)}>
        <span className={styles.caret}>{open ? '▾' : '▸'}</span>
        <span className={styles.signalName}>{signalLabel}</span>
        <span className={styles.signalCount}>{findings.length === 0 ? '✅ no findings' : `${findings.length} finding${findings.length === 1 ? '' : 's'}`}</span>
      </button>
      {open && findings.length > 0 && (
        <ul className={styles.findingList}>
          {sorted.map(f => (
            <li key={f.id}><FindingRow finding={f} onClick={onSelectFinding} showLayer={false} /></li>
          ))}
        </ul>
      )}
    </section>
  );
}
