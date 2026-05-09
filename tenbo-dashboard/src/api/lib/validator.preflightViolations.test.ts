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
  description: 'a roadmap item used for preflight tests now',
  done_when: ['it works'],
  goal_ref: ['g1'],
  ...over,
});

const warningsFor = (state: TenboState, id: string) =>
  validate(state).warnings.filter((w) => w.itemId === id).map((w) => w.message);

describe('validator — preflight_violations (sk-029)', () => {
  it('does not warn when item has no preflight_violations', () => {
    const state = stateWithItems([baseItem()]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('pre-flight violation'))).toBe(false);
  });

  it('warns when an active item has an accepted pre-flight violation', () => {
    const state = stateWithItems([baseItem({
      preflight_violations: [{
        check: 'ui-components anti-responsibility: no direct fs writes',
        outcome: 'violation',
        decision: 'accept-with-violation',
        rationale: 'one-off debug helper',
      }],
    })]);
    const msgs = warningsFor(state, 'ed-001');
    expect(msgs.some((m) => m.includes('accepted 1 pre-flight violation'))).toBe(true);
  });

  it('does not warn for done or dropped items even with accepted violations', () => {
    for (const status of ['done', 'dropped'] as const) {
      const state = stateWithItems([baseItem({
        status,
        preflight_violations: [{
          check: 'ui-components anti-responsibility: no direct fs writes',
          outcome: 'violation',
          decision: 'accept-with-violation',
        }],
      })]);
      const msgs = warningsFor(state, 'ed-001');
      expect(msgs.some((m) => m.includes('pre-flight violation'))).toBe(false);
    }
  });
});
