import { describe, it, expect } from 'vitest';
import { collectAll } from './collectAll';
import { DEFAULT_HEALTH_CONFIG } from './config';
import { findRepoRoot } from '../repoRoot';
import type { Scope } from '../../../types';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HealthConfig } from './config';
import type { Signal } from './types';
import { buildSourceIndex } from '../sourceIndex/build';
import { writeSourceIndex } from '../sourceIndex/store';

const NON_DEAD_CODE_SIGNALS: Signal[] = [
  'hotspot-files',
  'aging-todos',
  'doc-drift',
  'test-coverage',
  'architecture-compliance',
  'redundancy',
];

function deadCodeOnlyConfig(layerId: string): HealthConfig {
  return {
    ...DEFAULT_HEALTH_CONFIG,
    ignore: {
      ...DEFAULT_HEALTH_CONFIG.ignore,
      layer_signals: { [layerId]: NON_DEAD_CODE_SIGNALS },
    },
  };
}

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

  it('does not flag layer files imported by uncovered scope source files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'collect-dead-code-'));
    mkdirSync(path.join(root, 'apps/editor/src/domains/canvas/hooks'), { recursive: true });
    mkdirSync(path.join(root, 'apps/editor/src/shared'), { recursive: true });
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler', strict: false },
      include: ['apps/editor/src'],
    }));
    writeFileSync(path.join(root, 'apps/editor/tsconfig.json'), JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: {
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
      },
      include: ['src'],
    }));
    writeFileSync(path.join(root, 'apps/editor/src/domains/canvas/hooks/useCanvas.ts'), `export const useCanvas = () => null;`);
    writeFileSync(path.join(root, 'apps/editor/src/shared/CanvasConsumer.ts'), `import { useCanvas } from '@/domains/canvas/hooks/useCanvas';\nexport const consumer = useCanvas;`);
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

    const findings = await collectAll(root, scope, deadCodeOnlyConfig('visual-canvas'));
    expect(findings.find(f => f.signal === 'dead-code' && f.target === 'apps/editor/src/domains/canvas/hooks/useCanvas.ts')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses fresh source index graph evidence for dead-code findings', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'collect-index-dead-code-'));
    mkdirSync(path.join(root, 'apps/editor/src/feature'), { recursive: true });
    mkdirSync(path.join(root, '.tenbo/scopes/editor'), { recursive: true });
    writeFileSync(path.join(root, '.tenbo/workspace.yaml'), [
      'scopes:',
      '  - id: editor',
      '    path: apps/editor',
      '    description: editor scope',
      'cross_cutting: []',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, '.tenbo/overview.md'), '# Overview\n');
    writeFileSync(path.join(root, '.tenbo/scopes/editor/architecture.yaml'), [
      'layers:',
      '  - id: feature',
      '    name: Feature',
      '    description: feature code',
      '    files: ["src/feature/**"]',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, '.tenbo/scopes/editor/roadmap.yaml'), 'items: []\n');
    mkdirSync(path.join(root, '.tenbo/scopes/editor/layers/feature'), { recursive: true });
    writeFileSync(path.join(root, '.tenbo/scopes/editor/layers/feature/intent.md'), '# Feature\n');
    writeFileSync(path.join(root, '.tenbo/scopes/editor/layers/feature/code-map.md'), '# Feature Map\n');
    writeFileSync(path.join(root, 'apps/editor/tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler' },
      include: ['src'],
    }));
    writeFileSync(path.join(root, 'apps/editor/src/feature/unused.ts'), 'export const unused = 1;\n');
    const scope: Scope = {
      id: 'editor',
      path: 'apps/editor',
      description: '',
      layers: [{ id: 'feature', name: 'Feature', description: '', files: ['src/feature/**'] }],
      items: [],
    };
    writeSourceIndex(root, buildSourceIndex(root, { now: new Date('2026-06-30T00:00:00.000Z') }));

    const findings = await collectAll(root, scope, deadCodeOnlyConfig('feature'));

    const finding = findings.find(f => f.signal === 'dead-code' && f.target === 'apps/editor/src/feature/unused.ts');
    expect(finding?.details).toMatchObject({
      kind: 'dead-code',
      graph_evidence: { mode: 'fresh-index', index_status: 'fresh' },
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('suppresses graph-dependent findings when the source index is stale', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'collect-stale-index-'));
    mkdirSync(path.join(root, 'apps/editor/src/feature'), { recursive: true });
    mkdirSync(path.join(root, '.tenbo/scopes/editor'), { recursive: true });
    writeFileSync(path.join(root, '.tenbo/workspace.yaml'), [
      'scopes:',
      '  - id: editor',
      '    path: apps/editor',
      '    description: editor scope',
      'cross_cutting: []',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, '.tenbo/overview.md'), '# Overview\n');
    writeFileSync(path.join(root, '.tenbo/scopes/editor/architecture.yaml'), [
      'layers:',
      '  - id: feature',
      '    name: Feature',
      '    description: feature code',
      '    files: ["src/feature/**"]',
      '',
    ].join('\n'));
    writeFileSync(path.join(root, '.tenbo/scopes/editor/roadmap.yaml'), 'items: []\n');
    mkdirSync(path.join(root, '.tenbo/scopes/editor/layers/feature'), { recursive: true });
    writeFileSync(path.join(root, '.tenbo/scopes/editor/layers/feature/intent.md'), '# Feature\n');
    writeFileSync(path.join(root, '.tenbo/scopes/editor/layers/feature/code-map.md'), '# Feature Map\n');
    writeFileSync(path.join(root, 'apps/editor/tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler' },
      include: ['src'],
    }));
    writeFileSync(path.join(root, 'apps/editor/src/feature/unused.ts'), 'export const unused = 1;\n');
    writeSourceIndex(root, buildSourceIndex(root));
    writeFileSync(path.join(root, 'apps/editor/src/feature/unused.ts'), 'export const unused = 2;\n');
    const scope: Scope = {
      id: 'editor',
      path: 'apps/editor',
      description: '',
      layers: [{ id: 'feature', name: 'Feature', description: '', files: ['src/feature/**'] }],
      items: [],
    };

    const findings = await collectAll(root, scope, deadCodeOnlyConfig('feature'));

    expect(findings.some(f => f.signal === 'dead-code')).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
