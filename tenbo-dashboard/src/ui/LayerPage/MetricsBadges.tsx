import type { ScopeMetrics } from '../../types';

export function MetricsBadges({ scopeMetrics, layerId }: { scopeMetrics: ScopeMetrics | undefined; layerId: string }) {
  if (!scopeMetrics) return null;
  const layer = scopeMetrics.layers?.[layerId];
  if (!layer) return null;
  return (
    <div>
      <span>files: {layer.file_count}</span>
      {' '}
      <span>lines: {layer.total_lines}</span>
      {' '}
      <span>deps: {layer.outbound_deps}</span>
      {' '}
      <span>intent age: {layer.intent_age_days ?? 'n/a'}d</span>
    </div>
  );
}
