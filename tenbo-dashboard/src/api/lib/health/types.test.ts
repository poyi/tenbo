import { describe, it, expect } from 'vitest';
import type { Finding } from './types';
import { SEVERITY_RANK, SIGNAL_WEIGHTS_DEFAULT } from './types';

describe('health types', () => {
  it('SEVERITY_RANK orders critical > warning > info', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.warning);
    expect(SEVERITY_RANK.warning).toBeGreaterThan(SEVERITY_RANK.info);
  });

  it('SIGNAL_WEIGHTS_DEFAULT places dead-code first', () => {
    expect(SIGNAL_WEIGHTS_DEFAULT[0]).toBe('dead-code');
  });

  it('Finding type has the expected shape', () => {
    const f: Finding = {
      id: 'x.dead-code.foo',
      signal: 'dead-code',
      severity: 'critical',
      confidence: 'high',
      layer: 'x',
      target: 'apps/editor/foo.ts',
      headline: 'foo has no consumers',
      suggestion: { summary: 'Delete file', rationale: 'unused', action_kind: 'delete-file' },
      details: { kind: 'dead-code', exports: [], last_imported_commit: null, git_age_days: 0 },
    };
    expect(f.signal).toBe('dead-code');
  });
});
