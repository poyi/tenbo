import { describe, it, expect } from 'vitest';
import { parseHash, formatRoute } from './routes.js';

describe('parseHash', () => {
  it('defaults to docs project overview on empty hash', () => {
    expect(parseHash('')).toEqual({ kind: 'docs-project', tab: 'overview' });
    expect(parseHash('#/')).toEqual({ kind: 'docs-project', tab: 'overview' });
    expect(parseHash('#/docs')).toEqual({ kind: 'docs-project', tab: 'overview' });
  });
  it('parses docs project tab', () => {
    expect(parseHash('#/docs/glossary')).toEqual({ kind: 'docs-project', tab: 'glossary' });
  });
  it('parses docs scope', () => {
    expect(parseHash('#/docs/scope/editor')).toEqual({ kind: 'docs-scope', scopeId: 'editor' });
  });
  it('parses docs layer with default tab', () => {
    expect(parseHash('#/docs/scope/editor/layer/foo')).toEqual({ kind: 'docs-layer', scopeId: 'editor', layerId: 'foo', tab: 'overview' });
  });
  it('parses docs layer with explicit tab', () => {
    expect(parseHash('#/docs/scope/editor/layer/foo/purpose')).toEqual({ kind: 'docs-layer', scopeId: 'editor', layerId: 'foo', tab: 'purpose' });
  });
  it('parses roadmap with no filter', () => {
    expect(parseHash('#/roadmap')).toEqual({ kind: 'roadmap', scope: undefined, layer: undefined });
  });
  it('parses roadmap with scope and layer filters', () => {
    expect(parseHash('#/roadmap?scope=editor&layer=ai')).toEqual({ kind: 'roadmap', scope: 'editor', layer: 'ai' });
  });
  it('parses item', () => {
    expect(parseHash('#/item/cmp-001')).toEqual({ kind: 'item', itemId: 'cmp-001' });
  });
  it('redirects legacy workspace tab to docs', () => {
    expect(parseHash('#/workspace/principles')).toEqual({ kind: 'docs-project', tab: 'principles' });
  });
  it('redirects legacy workspace cross-cutting to roadmap', () => {
    expect(parseHash('#/workspace/cross-cutting')).toEqual({ kind: 'roadmap' });
  });
  it('redirects legacy scope to roadmap with filter', () => {
    expect(parseHash('#/scope/editor')).toEqual({ kind: 'roadmap', scope: 'editor' });
  });
  it('redirects legacy layer to docs-layer', () => {
    expect(parseHash('#/scope/editor/layer/foo/purpose')).toEqual({ kind: 'docs-layer', scopeId: 'editor', layerId: 'foo', tab: 'purpose' });
  });
  it('parses /health/<scope>/<layer>', () => {
    expect(parseHash('#/health/editor/visual-canvas')).toEqual({
      kind: 'health-layer', scopeId: 'editor', layerId: 'visual-canvas',
    });
  });
});

describe('formatRoute', () => {
  it('round-trips docs-layer', () => {
    expect(formatRoute({ kind: 'docs-layer', scopeId: 'editor', layerId: 'foo', tab: 'purpose' })).toBe('#/docs/scope/editor/layer/foo/purpose');
  });
  it('formats roadmap with filters', () => {
    expect(formatRoute({ kind: 'roadmap', scope: 'editor', layer: 'ai' })).toBe('#/roadmap?scope=editor&layer=ai');
  });
  it('formats roadmap without filters', () => {
    expect(formatRoute({ kind: 'roadmap' })).toBe('#/roadmap');
  });
  it('formats docs-project default tab compactly', () => {
    expect(formatRoute({ kind: 'docs-project', tab: 'overview' })).toBe('#/docs');
    expect(formatRoute({ kind: 'docs-project', tab: 'glossary' })).toBe('#/docs/glossary');
  });
  it('formats health-layer', () => {
    expect(formatRoute({ kind: 'health-layer', scopeId: 'editor', layerId: 'visual-canvas' })).toBe('#/health/editor/visual-canvas');
  });
});
