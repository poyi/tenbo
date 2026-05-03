import { describe, it, expect } from 'vitest';
import { analyzeArchCompliance } from './archCompliance';

describe('analyzeArchCompliance', () => {
  it('flags files placed outside the conventional subfolders', () => {
    const findings = analyzeArchCompliance('lyr', [
      'apps/editor/src/domains/x/application/RunFoo.ts',     // ok
      'apps/editor/src/domains/x/services/Bar.ts',           // ok
      'apps/editor/src/domains/x/RandomThing.ts',            // FLAG
      'apps/editor/src/domains/x/utility.ts',                // FLAG
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0].signal).toBe('architecture-compliance');
    expect(findings[0].severity).toBe('warning');
  });

  it('does not flag files inside conventional subfolders', () => {
    const findings = analyzeArchCompliance('lyr', [
      'apps/editor/src/domains/x/application/foo.ts',
      'apps/editor/src/domains/x/domain/bar.ts',
      'apps/editor/src/domains/x/infrastructure/baz.ts',
      'apps/editor/src/domains/x/ui/q.tsx',
    ]);
    expect(findings).toEqual([]);
  });
});
