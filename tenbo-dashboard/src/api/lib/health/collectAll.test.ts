import { describe, it, expect } from 'vitest';
import { collectAll } from './collectAll';
import { DEFAULT_HEALTH_CONFIG } from './config';
import { findRepoRoot } from '../repoRoot';
import type { Scope } from '../../../types';

describe('collectAll', () => {
  const repoRoot = findRepoRoot(process.cwd());

  it('returns findings array with the layer id present in each finding', async () => {
    if (!repoRoot) throw new Error('Could not find repo root');
    const scope: Scope = {
      id: 'editor', path: 'apps/editor', description: '',
      layers: [{
        id: 'visual-canvas', name: 'Visual Canvas', description: '',
        files: ['src/domains/canvas/**'],
        dependencies: { inbound: [], outbound: [], external: [] },
      }],
      items: [],
    };
    const findings = await collectAll(repoRoot, scope, DEFAULT_HEALTH_CONFIG);
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(f.layer).toBe('visual-canvas');
    }
  });

  it('skips signals that are opted-out via config.ignore.layer_signals', async () => {
    if (!repoRoot) throw new Error('Could not find repo root');
    const scope: Scope = {
      id: 'editor', path: 'apps/editor', description: '',
      layers: [{
        id: 'visual-canvas', name: 'Visual Canvas', description: '',
        files: ['src/domains/canvas/**'],
        dependencies: { inbound: [], outbound: [], external: [] },
      }],
      items: [],
    };
    const cfg = {
      ...DEFAULT_HEALTH_CONFIG,
      ignore: {
        ...DEFAULT_HEALTH_CONFIG.ignore,
        layer_signals: { 'visual-canvas': ['hotspot-files', 'aging-todos', 'doc-drift', 'test-coverage', 'architecture-compliance', 'dead-code', 'redundancy'] as const },
      },
    };
    const findings = await collectAll(repoRoot, scope, cfg as any);
    expect(findings).toEqual([]);
  });
});
