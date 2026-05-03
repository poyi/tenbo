import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import { childrenOf } from './relationships';
import type { TenboState, Item } from '../../types';

function stateWithItems(items: Item[]): TenboState {
  return {
    scopes: [{
      id: 'e',
      path: '.',
      description: 'editor scope description here for tests',
      layers: [{ id: 'l', name: 'L', description: 'a small layer for testing now', files: ['x'] } as any],
      items,
    }],
    crossCutting: [],
    narratives: { 'e/l': '# L' },
  } as any;
}

const baseItem = (over: Partial<Item> = {}): Item => ({
  id: 'ed-001',
  title: 't',
  layer: 'l',
  status: 'later',
  description: 'a roadmap item used for relationship tests now',
  ...over,
});

const errMsgsFor = (state: TenboState, id: string) =>
  validate(state).errors.filter((e) => e.itemId === id).map((e) => e.message);
const warnMsgsFor = (state: TenboState, id: string) =>
  validate(state).warnings.filter((e) => e.itemId === id).map((e) => e.message);

describe('validator — relationships', () => {
  it('accepts well-formed spawned_from + related with no errors or warnings', () => {
    const state = stateWithItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002' }),
      baseItem({ id: 'ed-003', spawned_from: 'ed-001', related: ['ed-002'] }),
    ]);
    expect(errMsgsFor(state, 'ed-003')).toEqual([]);
    expect(warnMsgsFor(state, 'ed-003')).toEqual([]);
  });

  it('warns when spawned_from references an unknown id', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', spawned_from: 'ed-999' })]);
    expect(warnMsgsFor(state, 'ed-001')).toContain(
      "ed-001 spawned_from references unknown id 'ed-999'",
    );
    expect(errMsgsFor(state, 'ed-001')).toEqual([]);
  });

  it('warns when related references an unknown id', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', related: ['ed-999'] })]);
    expect(warnMsgsFor(state, 'ed-001')).toContain(
      "ed-001 related references unknown id 'ed-999'",
    );
    expect(errMsgsFor(state, 'ed-001')).toEqual([]);
  });

  it('errors on self-reference in spawned_from', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', spawned_from: 'ed-001' })]);
    expect(errMsgsFor(state, 'ed-001').some((m) => /spawned_from cannot reference itself/.test(m))).toBe(true);
  });

  it('errors on self-reference in related', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', related: ['ed-001'] })]);
    expect(errMsgsFor(state, 'ed-001').some((m) => /related cannot reference itself/.test(m))).toBe(true);
  });

  it('warns on duplicate id in related', () => {
    const state = stateWithItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002' }),
      baseItem({ id: 'ed-003', related: ['ed-001', 'ed-001'] }),
    ]);
    expect(warnMsgsFor(state, 'ed-003').some((m) => /duplicate id 'ed-001'/.test(m))).toBe(true);
  });

  it('warns when same id appears in both spawned_from and related (redundant)', () => {
    const state = stateWithItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002', spawned_from: 'ed-001', related: ['ed-001'] }),
    ]);
    expect(warnMsgsFor(state, 'ed-002').some((m) => /both spawned_from and related/.test(m))).toBe(true);
  });

  it('errors on invalid id format in spawned_from', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', spawned_from: 'NotAnId' })]);
    expect(errMsgsFor(state, 'ed-001').some((m) => /invalid id format/.test(m))).toBe(true);
  });

  it('errors on invalid id format in related', () => {
    const state = stateWithItems([baseItem({ id: 'ed-001', related: ['BAD'] })]);
    expect(errMsgsFor(state, 'ed-001').some((m) => /invalid id format/.test(m))).toBe(true);
  });

  it('resolves cross-scope refs against the cross-cutting roadmap', () => {
    const state: TenboState = {
      ...stateWithItems([baseItem({ id: 'ed-001', spawned_from: 'x-001' })]),
      crossCuttingRoadmap: [
        { id: 'x-001', title: 'cross', status: 'now', description: 'a cross-cutting item', layers: [] } as any,
      ],
    };
    expect(warnMsgsFor(state, 'ed-001')).toEqual([]);
  });
});

describe('childrenOf helper', () => {
  it('returns items whose spawned_from matches the given parent id', () => {
    const items: Item[] = [
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002', spawned_from: 'ed-001' }),
      baseItem({ id: 'ed-003', spawned_from: 'ed-001' }),
      baseItem({ id: 'ed-004', spawned_from: 'ed-002' }),
      baseItem({ id: 'ed-005' }),
    ];
    const children = childrenOf(items, 'ed-001');
    expect(children.map((c) => c.id)).toEqual(['ed-002', 'ed-003']);
  });

  it('returns empty array when no children match', () => {
    const items: Item[] = [baseItem({ id: 'ed-001' }), baseItem({ id: 'ed-002' })];
    expect(childrenOf(items, 'ed-001')).toEqual([]);
  });
});
