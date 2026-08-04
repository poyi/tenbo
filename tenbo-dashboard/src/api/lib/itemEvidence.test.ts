import { describe, expect, it } from 'vitest';
import { checkItemEvidenceForItem } from './itemEvidence';
import type { Item } from '../../types';

describe('item evidence notes normalization', () => {
  it.each([
    { label: 'string', notes: 'Cloud note', expected: true },
    { label: 'array', notes: ['Cloud note', 'Second note'], expected: true },
    { label: 'empty string', notes: '', expected: false },
    { label: 'empty array', notes: [], expected: false },
    { label: 'absent', notes: undefined, expected: false },
  ])('handles $label notes at the evidence boundary', ({ notes, expected }) => {
    const item = {
      id: 'x-096',
      title: 'Evidence fixture',
      status: 'next',
      description: 'fixture',
      ...(notes === undefined ? {} : { notes }),
    } as Item;

    const report = checkItemEvidenceForItem(item);

    expect(report.signals.includes('notes')).toBe(expected);
  });
});
