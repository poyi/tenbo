import { useMemo } from 'react';
import type { TenboState } from '../../types';
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

export function HealthPage({ state, onSelectLayer, onSelectFinding }: Props) {
  const allFindings = useMemo<Finding[]>(() => {
    const out: Finding[] = [];
    for (const m of Object.values(state.metrics ?? {})) out.push(...(m.findings ?? []));
    return out;
  }, [state.metrics]);

  const totals = { critical: 0, warning: 0, info: 0 };
  for (const f of allFindings) totals[f.severity]++;

  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h1 className={styles.pageTitle}>Health overview</h1>
        <div className={styles.totals}>
          <SeverityLegend counts={totals} />
        </div>
      </section>

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
