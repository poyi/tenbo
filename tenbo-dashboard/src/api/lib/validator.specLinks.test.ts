import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import type { TenboState, Item } from '../../types';

function stateWithItems(items: Item[], specFiles?: Set<string>): TenboState {
  const s: TenboState = {
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
  if (specFiles) s.specFiles = specFiles;
  return s;
}

const baseItem = (over: Partial<Item> = {}): Item => ({
  id: 'ed-001',
  title: 't',
  layer: 'l',
  status: 'later',
  description: 'a roadmap item used for spec link tests now',
  ...over,
});

const warnMsgsFor = (state: TenboState, id: string) =>
  validate(state).warnings.filter((w) => w.itemId === id).map((w) => w.message);

describe('validator — spec links (Phase 6)', () => {
  it('warns when a .tenbo/specs/ link points to a missing file', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-001', links: ['.tenbo/specs/ed-001-foo.md'] })],
      new Set<string>(), // empty — file doesn't exist
    );
    expect(warnMsgsFor(state, 'ed-001')).toContain(
      'ed-001 links to .tenbo/specs/ed-001-foo.md which does not exist',
    );
  });

  it('warns when an item is done but its spec is not archived', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-002', status: 'done', links: ['.tenbo/specs/ed-002-foo.md'] })],
      new Set(['.tenbo/specs/ed-002-foo.md']),
    );
    expect(warnMsgsFor(state, 'ed-002')).toContain(
      "ed-002 is done but its spec hasn't been archived",
    );
  });

  it('warns when an item is not done but its spec is archived', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-003', status: 'now', links: ['.tenbo/specs/archive/ed-003-foo.md'] })],
      new Set(['.tenbo/specs/archive/ed-003-foo.md']),
    );
    expect(warnMsgsFor(state, 'ed-003')).toContain(
      'ed-003 is now but its spec is archived',
    );
  });

  it('warns when a link points at the legacy roadmap/ path', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-004', links: ['roadmap/ed-004-foo.md'] })],
    );
    expect(warnMsgsFor(state, 'ed-004')).toContain(
      'ed-004 links to old spec path; should be .tenbo/specs/ed-004-foo.md',
    );
  });

  it('does not warn for a healthy active spec link', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-005', status: 'now', links: ['.tenbo/specs/ed-005-foo.md'], done_when: ['ok'] })],
      new Set(['.tenbo/specs/ed-005-foo.md']),
    );
    expect(warnMsgsFor(state, 'ed-005')).toEqual([]);
  });

  it('does not warn for a healthy archived spec link on a done item', () => {
    const state = stateWithItems(
      [baseItem({ id: 'ed-006', status: 'done', links: ['.tenbo/specs/archive/ed-006-foo.md'] })],
      new Set(['.tenbo/specs/archive/ed-006-foo.md']),
    );
    expect(warnMsgsFor(state, 'ed-006')).toEqual([]);
  });

  it('does not warn on done items whose links do not point into .tenbo/specs/', () => {
    // E.g. items linking to external docs or that never had a spec.
    const state = stateWithItems(
      [baseItem({ id: 'ed-007', status: 'done', links: ['docs/something.md'] })],
    );
    expect(warnMsgsFor(state, 'ed-007')).toEqual([]);
  });
});
