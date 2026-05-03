import { CONFIDENCE_RANK, SEVERITY_RANK, type Finding, type Severity, type Signal } from '../../api/lib/health/types';

export function sortFindings(findings: Finding[], signalWeights: readonly Signal[]): Finding[] {
  const weightOf = (s: Signal): number => {
    const i = signalWeights.indexOf(s);
    return i === -1 ? signalWeights.length : i;
  };
  return findings.slice().sort((a, b) => {
    const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sev !== 0) return sev;
    const sig = weightOf(a.signal) - weightOf(b.signal);
    if (sig !== 0) return sig;
    return CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence];
  });
}

export function severityColor(s: Severity): string {
  return s === 'critical' ? 'var(--health-critical, #f56565)'
       : s === 'warning'  ? 'var(--health-warning, #ecc94b)'
       :                    'var(--health-info, #4299e1)';
}
