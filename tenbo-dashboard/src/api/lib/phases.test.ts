import { describe, it, expect } from 'vitest';
import { derivePhaseStatus, effectiveStatus, phaseProgress, isIsoDate } from './phases';
import type { Item, Phase } from '../../types';

const ph = (id: number, status: Phase['status'], extra: Partial<Phase> = {}): Phase => ({
  id,
  title: `phase ${id}`,
  status,
  ...extra,
});

describe('derivePhaseStatus', () => {
  it('returns done when every phase is done', () => {
    expect(derivePhaseStatus([ph(1, 'done'), ph(2, 'done')])).toBe('done');
  });

  it('returns now if any phase is now (even with later mixed in)', () => {
    expect(derivePhaseStatus([ph(1, 'done'), ph(2, 'now'), ph(3, 'later')])).toBe('now');
  });

  it('returns next when no now but some next', () => {
    expect(derivePhaseStatus([ph(1, 'done'), ph(2, 'next'), ph(3, 'later')])).toBe('next');
  });

  it('returns later when only later/done remain', () => {
    expect(derivePhaseStatus([ph(1, 'done'), ph(2, 'later')])).toBe('later');
  });

  it('returns later for an empty list', () => {
    expect(derivePhaseStatus([])).toBe('later');
  });
});

describe('effectiveStatus', () => {
  it('uses stored status when phases are absent', () => {
    const item = { id: 'ed-001', title: 't', status: 'next', description: 'd' } as Item;
    expect(effectiveStatus(item)).toBe('next');
  });

  it('uses derived status when phases are present', () => {
    const item = {
      id: 'ed-001',
      title: 't',
      status: 'later',
      description: 'd',
      phases: [ph(1, 'done'), ph(2, 'now')],
    } as Item;
    expect(effectiveStatus(item)).toBe('now');
  });
});

describe('phaseProgress', () => {
  it('counts done and total and surfaces the active phase', () => {
    const phases = [ph(1, 'done'), ph(2, 'now'), ph(3, 'later')];
    const p = phaseProgress(phases);
    expect(p.done).toBe(1);
    expect(p.total).toBe(3);
    expect(p.active?.id).toBe(2);
  });

  it('omits active when no phase is now', () => {
    const p = phaseProgress([ph(1, 'done'), ph(2, 'next')]);
    expect(p.active).toBeUndefined();
  });
});

describe('isIsoDate', () => {
  it('accepts YYYY-MM-DD', () => {
    expect(isIsoDate('2026-04-27')).toBe(true);
  });
  it('rejects other formats', () => {
    expect(isIsoDate('2026-4-27')).toBe(false);
    expect(isIsoDate('04/27/2026')).toBe(false);
    expect(isIsoDate('2026-04-27T00:00:00Z')).toBe(false);
  });
});
