import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import type { TenboState, Item } from '../../types';

const baseItem = (over: Partial<Item> = {}): Item => ({
  id: 'ed-001',
  title: 't',
  layer: 'l',
  status: 'later',
  description: 'a roadmap item used for duplicate-id tests now',
  ...over,
});

function stateWithScopeItems(items: Item[], archived: Item[] = []): TenboState {
  return {
    scopes: [{
      id: 'e',
      path: '.',
      description: 'editor scope description here for tests',
      layers: [{ id: 'l', name: 'L', description: 'a small layer for testing now', files: ['x'] } as any],
      items,
      archivedItems: archived,
    }],
    crossCutting: [],
    narratives: { 'e/l': '# L' },
  } as any;
}

const dupErrors = (state: TenboState) =>
  validate(state).errors.filter((e) => /^duplicate item id/.test(e.message)).map((e) => e.message);

describe('validator — duplicate item ids', () => {
  it('emits no duplicate-id error when every id appears once', () => {
    const state = stateWithScopeItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002' }),
      baseItem({ id: 'ed-003' }),
    ]);
    expect(dupErrors(state)).toEqual([]);
  });

  it('errors when two active items share an id', () => {
    const state = stateWithScopeItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-001', title: 'dup' }),
    ]);
    const msgs = dupErrors(state);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/duplicate item id "ed-001"/);
    expect(msgs[0]).toMatch(/active/);
  });

  it('errors when an id appears once in active and once in archive', () => {
    const state = stateWithScopeItems(
      [baseItem({ id: 'ed-001' })],
      [baseItem({ id: 'ed-001', status: 'done' })],
    );
    const msgs = dupErrors(state);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/active/);
    expect(msgs[0]).toMatch(/archive/);
  });

  it('errors when an id appears in cross-cutting and a scope', () => {
    const state: TenboState = {
      ...stateWithScopeItems([baseItem({ id: 'x-001' })]),
      crossCuttingRoadmap: [
        { id: 'x-001', title: 'cross', status: 'now', description: 'a cross-cutting item', layers: [] } as any,
      ],
    };
    const msgs = dupErrors(state);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/cross-cutting/);
  });

  it('emits one error per duplicated id, not one per duplicate occurrence', () => {
    const state = stateWithScopeItems([
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-001' }),
      baseItem({ id: 'ed-002' }),
      baseItem({ id: 'ed-002' }),
      baseItem({ id: 'ed-003' }),
    ]);
    const msgs = dupErrors(state);
    expect(msgs.length).toBe(2);
    expect(msgs.some((m) => m.includes('ed-001'))).toBe(true);
    expect(msgs.some((m) => m.includes('ed-002'))).toBe(true);
  });
});
