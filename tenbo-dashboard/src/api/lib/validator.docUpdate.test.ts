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
  status: 'done',
  description: 'a roadmap item used for doc_update tests now',
  ...over,
});

const issuesFor = (state: TenboState, id: string) => {
  const r = validate(state);
  return {
    warnings: r.warnings.filter((w) => w.itemId === id).map((w) => w.message),
    errors: r.errors.filter((e) => e.itemId === id).map((e) => e.message),
  };
};

describe('validator — doc_update gate (x-003 phase 3)', () => {
  it('warns when a done feature/refactor/bug item is missing doc_update', () => {
    for (const type of ['feature', 'refactor', 'bug'] as const) {
      const state = stateWithItems([baseItem({ id: `ed-00${1}`, type })]);
      const { warnings } = issuesFor(state, 'ed-001');
      expect(warnings.some((m) => m.includes('doc_update is not stamped'))).toBe(true);
    }
  });

  it('does not warn when doc_update is a valid ISO date', () => {
    const state = stateWithItems([baseItem({ type: 'feature', doc_update: '2026-04-28' })]);
    expect(issuesFor(state, 'ed-001').warnings).toEqual([]);
  });

  it('does not warn when doc_update is a skipped reason with em-dash', () => {
    const state = stateWithItems([baseItem({ type: 'refactor', doc_update: 'skipped — internal helper rename only' })]);
    expect(issuesFor(state, 'ed-001').warnings).toEqual([]);
  });

  it('does not warn when doc_update is a skipped reason with hyphen or colon separator', () => {
    for (const sep of [' - ', ': ']) {
      const state = stateWithItems([baseItem({ type: 'bug', doc_update: `skipped${sep}no architecture impact` })]);
      expect(issuesFor(state, 'ed-001').warnings).toEqual([]);
    }
  });

  it('warns when doc_update is malformed (neither date nor skipped reason)', () => {
    const state = stateWithItems([baseItem({ type: 'feature', doc_update: 'yes I did' })]);
    const { warnings } = issuesFor(state, 'ed-001');
    expect(warnings.some((m) => m.includes('is malformed'))).toBe(true);
  });

  it('errors when doc_update is not a string', () => {
    const state = stateWithItems([baseItem({ type: 'feature', doc_update: 123 as any })]);
    const { errors } = issuesFor(state, 'ed-001');
    expect(errors.some((m) => m.includes('must be a string'))).toBe(true);
  });

  it('does not warn when item has no type set (exemption for un-typed items)', () => {
    const state = stateWithItems([baseItem({ /* no type */ })]);
    const { warnings } = issuesFor(state, 'ed-001');
    expect(warnings.some((m) => m.includes('doc_update'))).toBe(false);
  });

  it('does not warn for spike items even when doc_update is missing', () => {
    const state = stateWithItems([baseItem({ type: 'spike' })]);
    const { warnings } = issuesFor(state, 'ed-001');
    expect(warnings.some((m) => m.includes('doc_update'))).toBe(false);
  });

  it('does not warn for items with status other than done', () => {
    for (const status of ['now', 'next', 'later'] as const) {
      const state = stateWithItems([baseItem({ status, type: 'feature', done_when: ['ok'] })]);
      const { warnings } = issuesFor(state, 'ed-001');
      expect(warnings.some((m) => m.includes('doc_update'))).toBe(false);
    }
  });

  it('warns when doc_update is empty string', () => {
    const state = stateWithItems([baseItem({ type: 'feature', doc_update: '' })]);
    const { warnings } = issuesFor(state, 'ed-001');
    expect(warnings.some((m) => m.includes('doc_update is not stamped'))).toBe(true);
  });
});
