import type { TenboState } from '../../types';
import type { Finding, Signal } from '../../api/lib/health/types';
import { SignalSection } from './SignalSection';
import { SeverityLegend } from '../HealthPage/SeverityLegend';
import styles from './LayerDetailPage.module.css';

interface Props {
  state: TenboState;
  scopeId: string;
  layerId: string;
  onBack: () => void;
  onSelectFinding: (f: Finding) => void;
}

const SIGNAL_LABELS: Record<Signal, string> = {
  'hotspot-files': 'Hotspot files',
  'dead-code': 'Dead code',
  'coupling': 'Cross-layer coupling',
  'doc-drift': 'Doc drift',
  'test-coverage': 'Test coverage',
  'aging-todos': 'Aging TODOs',
  'architecture-compliance': 'Architecture compliance',
  'redundancy': 'Redundancy',
};

export function LayerDetailPage({ state, scopeId, layerId, onBack, onSelectFinding }: Props) {
  const scope = state.scopes.find(s => s.id === scopeId);
  const layer = scope?.layers.find(l => l.id === layerId);
  const metrics = state.metrics?.[scopeId]?.layers[layerId];
  const findings = (state.metrics?.[scopeId]?.findings ?? []).filter(f => f.layer === layerId);
  if (!scope || !layer || !metrics) return <div className={styles.page}>Layer not found.</div>;
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const bySignal = (sig: Signal) => findings.filter(f => f.signal === sig);

  return (
    <div className={styles.page}>
      <button type="button" className={styles.back} onClick={onBack}>← Back to health</button>
      <h1 className={styles.title}>{layer.name}</h1>
      <div className={styles.statsRow}>
        <span>{metrics.file_count.toLocaleString()} files</span>
        <span>·</span>
        <span>{metrics.total_lines.toLocaleString()} LOC</span>
      </div>
      <div className={styles.legendRow}>
        <SeverityLegend counts={counts} />
      </div>
      {(Object.keys(SIGNAL_LABELS) as Signal[]).map(sig => (
        <SignalSection
          key={sig}
          signal={sig}
          signalLabel={SIGNAL_LABELS[sig]}
          findings={bySignal(sig)}
          onSelectFinding={onSelectFinding}
        />
      ))}
    </div>
  );
}
