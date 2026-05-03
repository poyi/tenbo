import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import type { TenboState, Item, Phase } from '../../types';

function baseState(items: Item[] = []): TenboState {
  return {
    scopes: [{
      id: 'e', path: '.', description: 'editor scope description here for tests',
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
  description: 'a roadmap item with phases for testing now',
  ...over,
});

const ph = (id: number, status: Phase['status'], extra: Partial<Phase> = {}): Phase => ({
  id,
  title: `phase ${id}`,
  status,
  ...extra,
});

describe('validator — phase schema', () => {
  it('accepts a well-formed phases list with no errors', () => {
    const item = baseItem({
      phases: [ph(1, 'done', { completed_at: '2026-04-27' }), ph(2, 'now')],
    });
    const r = validate(baseState([item]));
    const phaseErrors = r.errors.filter((e) => e.itemId === 'ed-001');
    expect(phaseErrors).toEqual([]);
  });

  it('errors when a phase id does not match its 1-based position', () => {
    const item = baseItem({ phases: [ph(1, 'done'), ph(3, 'now')] });
    const r = validate(baseState([item]));
    expect(r.errors.some((e) => /id 3.*1\.\.N/.test(e.message))).toBe(true);
  });

  it('errors when a phase has a non-integer id', () => {
    const item = baseItem({ phases: [{ title: 'p', status: 'later' } as any] });
    const r = validate(baseState([item]));
    expect(r.errors.some((e) => /missing an integer id/.test(e.message))).toBe(true);
  });

  it('errors when a phase is missing title', () => {
    const item = baseItem({ phases: [{ id: 1, status: 'later' } as any] });
    const r = validate(baseState([item]));
    expect(r.errors.some((e) => /missing a title/.test(e.message))).toBe(true);
  });

  it('errors on invalid phase status', () => {
    const item = baseItem({ phases: [{ id: 1, title: 'x', status: 'wip' } as any] });
    const r = validate(baseState([item]));
    expect(r.errors.some((e) => /invalid status "wip"/.test(e.message))).toBe(true);
  });

  it('errors when completed_at is not YYYY-MM-DD', () => {
    const item = baseItem({ phases: [ph(1, 'done', { completed_at: '04/27/2026' })] });
    const r = validate(baseState([item]));
    expect(r.errors.some((e) => /completed_at.*YYYY-MM-DD/.test(e.message))).toBe(true);
  });
});

describe('validator — phase warnings', () => {
  it('warns when phase is done but completed_at missing', () => {
    const item = baseItem({ phases: [ph(1, 'done')] });
    const r = validate(baseState([item]));
    expect(r.warnings.some((w) => /done but has no completed_at/.test(w.message))).toBe(true);
  });

  it('warns when completed_at set but status not done', () => {
    const item = baseItem({ phases: [ph(1, 'now', { completed_at: '2026-04-27' })] });
    const r = validate(baseState([item]));
    expect(r.warnings.some((w) => /has completed_at but status is "now"/.test(w.message))).toBe(true);
  });

  it('warns when both status and phases are present', () => {
    const item = baseItem({ status: 'now', phases: [ph(1, 'now')] });
    const r = validate(baseState([item]));
    expect(r.warnings.some((w) => /both status and phases/.test(w.message))).toBe(true);
  });

  it('does not warn for items without phases', () => {
    const item = baseItem({ status: 'now', done_when: ['x'] });
    const r = validate(baseState([item]));
    expect(r.warnings.some((w) => /both status and phases/.test(w.message))).toBe(false);
  });
});
