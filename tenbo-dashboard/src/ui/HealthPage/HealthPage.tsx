import { useMemo } from 'react';
import type { MetricsRefreshStatus, MetricsRefreshState, TenboState } from '../../types';
import type { Finding } from '../../api/lib/health/types';
import { SIGNAL_WEIGHTS_DEFAULT } from '../../api/lib/health/types';
import { Digest } from './Digest';
import { LayerCard } from './LayerCard';
import { SeverityLegend } from './SeverityLegend';
import styles from './HealthPage.module.css';

interface Props {
  state: TenboState;
  onSelectLayer: (scopeId: string, layerId: string) => void;
  onSelectFinding: (finding: Finding) => void;
}

const STATUS_PRIORITY: Record<MetricsRefreshState, number> = {
  failed: 0,
  refreshing: 1,
  stale: 2,
  fresh: 3,
};

function summarizeMetricsStatus(statuses: Record<string, MetricsRefreshStatus> | undefined): MetricsRefreshStatus | null {
  const visible = Object.values(statuses ?? {}).filter((status) => status.status !== 'fresh');
  if (visible.length === 0) return null;
  return visible.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])[0];
}

export function HealthPage({ state, onSelectLayer, onSelectFinding }: Props) {
  const allFindings = useMemo<Finding[]>(() => {
    const out: Finding[] = [];
    for (const m of Object.values(state.metrics ?? {})) out.push(...(m.findings ?? []));
    return out;
  }, [state.metrics]);

  const totals = { critical: 0, warning: 0, info: 0 };
  for (const f of allFindings) totals[f.severity]++;
  const metricsStatus = summarizeMetricsStatus(state.metricsStatus);

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h1 className={styles.pageTitle}>Health overview</h1>
        <div className={styles.totals}>
          <SeverityLegend counts={totals} />
        </div>
      </section>

      {metricsStatus && (
        <div className={styles.statusBanner} role="status">
          <span className={styles.statusTitle}>
            Health metrics {metricsStatus.status}
          </span>
          <span>{metricsStatus.warning ?? metricsStatus.message ?? metricsStatus.error}</span>
        </div>
      )}

      <Digest
        findings={allFindings}
        signalWeights={SIGNAL_WEIGHTS_DEFAULT}
        onSelect={onSelectFinding}
      />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Layers</h2>
        <div className={styles.layerGrid}>
          {state.scopes.flatMap(scope =>
            scope.layers.map(layer => {
              const metrics = state.metrics?.[scope.id]?.layers[layer.id];
              const findings = (state.metrics?.[scope.id]?.findings ?? []).filter(f => f.layer === layer.id);
              if (!metrics) return null;
              return (
                <LayerCard
                  key={`${scope.id}/${layer.id}`}
                  scopeId={scope.id}
                  layerId={layer.id}
                  layerName={layer.name}
                  metrics={metrics}
                  findings={findings}
                  onSelect={() => onSelectLayer(scope.id, layer.id)}
                />
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
