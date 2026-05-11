import { describe, it, expect } from 'vitest';
import { sortByPriority, comparePriority } from './priority';
import type { Item, Priority } from '../../types';

const item = (id: string, priority?: Priority): Item =>
  ({ id, title: id, status: 'now', description: '', priority } as unknown as Item);

describe('sortByPriority', () => {
  it('orders p0 → p1 → p2 → p3 → unset', () => {
    const input = [
      item('a', 'p3'),
      item('b'),
      item('c', 'p0'),
      item('d', 'p2'),
      item('e', 'p1'),
    ];
    const sorted = sortByPriority(input).map(i => i.id);
    expect(sorted).toEqual(['c', 'e', 'd', 'a', 'b']);
  });

  it('preserves file order on ties (stable sort)', () => {
    const input = [
      item('first', 'p2'),
      item('second', 'p2'),
      item('third', 'p2'),
      item('zeroth', 'p0'),
    ];
    const sorted = sortByPriority(input).map(i => i.id);
    expect(sorted).toEqual(['zeroth', 'first', 'second', 'third']);
  });

  it('returns a new array (does not mutate input)', () => {
    const input = [item('a', 'p3'), item('b', 'p0')];
    const inputCopy = [...input];
    sortByPriority(input);
    expect(input).toEqual(inputCopy);
  });
});

describe('comparePriority', () => {
  it('returns negative when first has higher priority', () => {
    expect(comparePriority(item('a', 'p0'), item('b', 'p3'))).toBeLessThan(0);
  });
  it('returns positive when second has higher priority', () => {
    expect(comparePriority(item('a', 'p3'), item('b', 'p0'))).toBeGreaterThan(0);
  });
  it('returns 0 on equal priority (file-order tiebreaker)', () => {
    expect(comparePriority(item('a', 'p2'), item('b', 'p2'))).toBe(0);
  });
  it('treats unset as the lowest priority', () => {
    expect(comparePriority(item('a'), item('b', 'p3'))).toBeGreaterThan(0);
    expect(comparePriority(item('a', 'p0'), item('b'))).toBeLessThan(0);
  });
});
