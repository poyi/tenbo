import { describe, it, expect } from 'vitest';
import { validate } from './validator';
import type { TenboState } from '../../types';

function baseState(): TenboState {
  return {
    scopes: [{
      id: 'e', path: '.', description: 'editor scope description here',
      layers: [{ id: 'l', name: 'L', description: 'a small layer for testing now', files: ['x'] } as any],
      items: [],
    }],
    crossCutting: [],
    narratives: { 'e/l': '# L' },
  } as any;
}

describe('validator v2 errors', () => {
  it('errors when intent.md is empty but exists', () => {
    const s = baseState();
    s.layerDocs = { 'e/l': { hasIntent: true, hasCodeMap: false, intentMtime: 0, codeMapMtime: null, intentEmpty: true } as any };
    const r = validate(s);
    expect(r.errors.some(e => /intent\.md.*empty/i.test(e.message))).toBe(true);
  });

  it('errors when dependencies edge points to nonexistent layer', () => {
    const s = baseState();
    (s.scopes[0].layers[0] as any).dependencies = { outbound: ['ghost'] };
    const r = validate(s);
    expect(r.errors.some(e => /dependencies.*ghost/i.test(e.message))).toBe(true);
  });

  it('errors when cross-cutting roadmap item references nonexistent scope', () => {
    const s = baseState();
    s.crossCuttingRoadmap = [{ id: 'x-001', title: 't', status: 'later', description: 'a workspace level item description', layers: ['ghost:l'] } as any];
    const r = validate(s);
    expect(r.errors.some(e => /ghost:l.*resolve/i.test(e.message))).toBe(true);
  });
});

describe('validator v2 warnings', () => {
  it('warns when layer has no code-map.md', () => {
    const s = baseState();
    s.layerDocs = { 'e/l': { hasIntent: false, hasCodeMap: false, intentMtime: null, codeMapMtime: null, intentEmpty: false } as any };
    const r = validate(s);
    expect(r.warnings.some(w => /code-map\.md/i.test(w.message))).toBe(true);
  });

  it('warns when status:now item missing done_when', () => {
    const s = baseState();
    s.scopes[0].items.push({ id: 'ed-001', title: 't', layer: 'l', status: 'now', description: 'a now item without done criteria' } as any);
    const r = validate(s);
    expect(r.warnings.some(w => /ed-001.*done_when/i.test(w.message))).toBe(true);
  });

});
