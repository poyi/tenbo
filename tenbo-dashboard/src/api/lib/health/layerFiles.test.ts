import { describe, it, expect } from 'vitest';
import { resolveLayerFiles } from './layerFiles';
import { findRepoRoot } from '../repoRoot';
import type { Scope } from '../../../types';

describe('resolveLayerFiles', () => {
  const repoRoot = findRepoRoot(process.cwd());

  it('returns repo-relative paths bucketed by layer', () => {
    if (!repoRoot) throw new Error('Could not find repo root');
    // Use a real fixture: this repo's editor scope.
    const scope: Scope = {
      id: 'editor',
      path: 'apps/editor',
      description: '',
      layers: [{
        id: 'visual-canvas',
        name: 'Visual Canvas',
        description: '',
        files: ['src/domains/canvas/**'],
        dependencies: { inbound: [], outbound: [], external: [] },
      }],
      items: [],
    };
    const result = resolveLayerFiles(repoRoot, scope);
    expect(result['visual-canvas']).toBeDefined();
    expect(result['visual-canvas'].length).toBeGreaterThan(0);
    // Paths are repo-relative
    expect(result['visual-canvas'][0]).toMatch(/^apps\/editor\/src\/domains\/canvas\//);
  });

  it('returns empty array for layer with no matching files', () => {
    if (!repoRoot) throw new Error('Could not find repo root');
    const scope: Scope = {
      id: 'editor', path: 'apps/editor', description: '',
      layers: [{
        id: 'nonexistent', name: '', description: '',
        files: ['src/domains/does-not-exist/**'],
        dependencies: { inbound: [], outbound: [], external: [] },
      }],
      items: [],
    };
    const result = resolveLayerFiles(repoRoot, scope);
    expect(result['nonexistent']).toEqual([]);
  });
});
