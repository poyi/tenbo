import { describe, it, expect } from 'vitest';
import { validate } from './validator';
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
  status: 'now',
  description: 'a roadmap item used for goal_ref tests now',
  done_when: ['it works'],
  ...over,
});

const warningsFor = (state: TenboState, id: string) =>
  validate(state).warnings.filter((w) => w.itemId === id).map((w) => w.message);

describe('validator — goal_ref shape (sk-025)', () => {
  it('warns when goal_ref is missing on an active item', () => {
    const state = stateWithItems([baseItem()]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('has no goal_ref'))).toBe(true);
  });

  it('does not warn when goal_ref is missing on a done or dropped item', () => {
    for (const status of ['done', 'dropped'] as const) {
      const state = stateWithItems([baseItem({ status })]);
      const msgs = warningsFor(state, 'ed-001');
      expect(msgs.some((m) => m.includes('has no goal_ref'))).toBe(false);
    }
  });

  it('does not warn when goal_ref is a non-empty string array', () => {
    const state = stateWithItems([baseItem({ goal_ref: ['g1', 'g3'] })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('goal_ref'))).toBe(false);
  });

  it('does not warn when goal_ref is the literal "exploratory"', () => {
    const state = stateWithItems([baseItem({ goal_ref: 'exploratory' })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('goal_ref'))).toBe(false);
  });

  it('warns when goal_ref is an empty array', () => {
    const state = stateWithItems([baseItem({ goal_ref: [] })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('empty array'))).toBe(true);
  });

  it('warns when goal_ref is a malformed value (string other than "exploratory")', () => {
    const state = stateWithItems([baseItem({ goal_ref: 'g1' as any })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('must be a string array or the literal "exploratory"'))).toBe(true);
  });

  it('warns when goal_ref array contains a non-string entry', () => {
    const state = stateWithItems([baseItem({ goal_ref: [1 as any, 'g2'] as any })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('must be a string array'))).toBe(true);
  });
});
