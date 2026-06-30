import { describe, expect, it } from 'vitest';
import { querySourceIndex } from './query';
import type { SourceIndex } from './types';

const index: SourceIndex = {
  schema_version: 1,
  generated_at: '2026-06-30T00:00:00.000Z',
  repo_root_fingerprint: 'repo',
  inputs: {},
  files: [
    {
      path: 'tenbo-dashboard/scripts/impact.ts',
      scope: 'dashboard',
      layers: ['cli-tools'],
      kind: 'source',
      tokens: ['dashboard', 'cli', 'impact', 'command'],
      exports: ['runImpactCli'],
      imports: [],
      imported_by: [],
      symbols: ['runImpactCli'],
      line_count: 12,
    },
    {
      path: 'skill/SKILL.md',
      scope: 'skill',
      layers: ['core-logic'],
      kind: 'docs',
      tokens: ['skill', 'impact', 'context'],
      exports: [],
      imports: [],
      imported_by: [],
      symbols: [],
      line_count: 12,
    },
  ],
  layers: [
    {
      scope: 'dashboard',
      layer: 'cli-tools',
      files: ['tenbo-dashboard/scripts/impact.ts'],
      public_entrypoints: [],
      tokens: ['dashboard', 'cli', 'command'],
    },
    {
      scope: 'skill',
      layer: 'core-logic',
      files: ['skill/SKILL.md'],
      public_entrypoints: [],
      tokens: ['skill', 'context'],
    },
  ],
  warnings: [],
};

describe('querySourceIndex', () => {
  it('scores scopes layers and source files from indexed tokens', () => {
    const result = querySourceIndex(index, 'dashboard CLI impact command');

    expect(result.scopeScores.get('dashboard')).toBeGreaterThan(result.scopeScores.get('skill') ?? 0);
    expect(result.layerScores.get('dashboard:cli-tools')).toBeGreaterThan(0);
    expect(result.files[0]).toMatchObject({
      path: 'tenbo-dashboard/scripts/impact.ts',
      scope: 'dashboard',
      layers: ['cli-tools'],
      score: expect.any(Number),
    });
  });
});
