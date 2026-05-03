import { describe, it, expect } from 'vitest';
import { sortFindings, severityColor } from './severity';
import type { Finding } from '../../api/lib/health/types';

const f = (over: Partial<Finding>): Finding => ({
  id: 'x', signal: 'hotspot-files', severity: 'warning', confidence: 'high',
  layer: 'l', target: 't', headline: 'h',
  suggestion: { summary: '', rationale: '', action_kind: 'split-file' },
  details: { kind: 'hotspot-files', loc: 0, top_functions: [], commits_30d: 0, split_candidates: [] },
  ...over,
});

describe('sortFindings', () => {
  const weights = ['dead-code', 'hotspot-files', 'aging-todos'] as const;
  it('orders by severity tier first', () => {
    const sorted = sortFindings([
      f({ id: 'a', severity: 'info' }),
      f({ id: 'b', severity: 'critical' }),
      f({ id: 'c', severity: 'warning' }),
    ], weights as any);
    expect(sorted.map(x => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by signal weight', () => {
    const sorted = sortFindings([
      f({ id: 'a', severity: 'critical', signal: 'aging-todos' }),
      f({ id: 'b', severity: 'critical', signal: 'dead-code' }),
    ], weights as any);
    expect(sorted.map(x => x.id)).toEqual(['b', 'a']);
  });

  it('breaks remaining ties by confidence', () => {
    const sorted = sortFindings([
      f({ id: 'a', severity: 'critical', signal: 'dead-code', confidence: 'low' }),
      f({ id: 'b', severity: 'critical', signal: 'dead-code', confidence: 'high' }),
    ], weights as any);
    expect(sorted.map(x => x.id)).toEqual(['b', 'a']);
  });
});

describe('severityColor', () => {
  it('returns distinct strings per severity', () => {
    expect(severityColor('critical')).not.toBe(severityColor('warning'));
    expect(severityColor('warning')).not.toBe(severityColor('info'));
  });
});
