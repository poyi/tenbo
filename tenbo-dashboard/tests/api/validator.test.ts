import { describe, it, expect } from 'vitest';
import { validate } from '../../src/api/lib/validator';
import type { TenboState } from '../../src/types';

const baseState: TenboState = {
  scopes: [{
    id: 'editor',
    path: 'apps/editor',
    description: 'editor',
    layers: [{ id: 'a', name: 'A', description: 'the a', files: ['src/a/**'] }],
    items: [{ id: 'rm-001', title: 'x', layer: 'a', status: 'later', description: 'a thing' }],
  }],
  crossCutting: [],
  narratives: { 'editor/a': '# A\n' },
  workspaceContent: {
    principlesMd: '',
    glossaryMd: '',
    observationsMd: '',
    overviewMd: '',
    principlesMtime: null,
    glossaryMtime: null,
    observationsMtime: null,
    overviewMtime: null,
  },
};

describe('validator', () => {
  it('returns no errors for a valid state', () => {
    const r = validate(baseState);
    expect(r.errors).toHaveLength(0);
  });

  it('errors when an item references a missing layer', () => {
    const s: TenboState = JSON.parse(JSON.stringify(baseState));
    s.scopes[0].items[0].layer = 'nope';
    const r = validate(s);
    expect(r.errors.some(e => e.itemId === 'rm-001')).toBe(true);
  });

  it('errors when a layer has no narrative', () => {
    const s: TenboState = JSON.parse(JSON.stringify(baseState));
    s.narratives = {};
    const r = validate(s);
    expect(r.errors.some(e => e.layerId === 'a')).toBe(true);
  });

  it('warns on jargon in description', () => {
    const s: TenboState = JSON.parse(JSON.stringify(baseState));
    s.scopes[0].items[0].description = 'expose an endpoint for it';
    const r = validate(s);
    expect(r.warnings.some(w => w.itemId === 'rm-001')).toBe(true);
  });
});
