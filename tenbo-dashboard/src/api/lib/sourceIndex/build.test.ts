import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildSourceIndex } from './build';
import { SOURCE_INDEX_SCHEMA_VERSION } from './store';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-source-index-build-'));
  write('.tenbo/workspace.yaml', [
    'scopes:',
    '  - id: dashboard',
    '    path: tenbo-dashboard',
    '    description: dashboard scope',
    '  - id: skill',
    '    path: skill',
    '    description: skill scope',
    'cross_cutting: []',
    '',
  ].join('\n'));
  write('.tenbo/overview.md', '# Overview\n');
  write('.tenbo/scopes/dashboard/architecture.yaml', [
    'layers:',
    '  - id: data-layer',
    '    name: Data Layer',
    '    description: Data helpers',
    '    files: ["src/api/**", "src/types.ts"]',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: CLI helpers',
    '    files: ["scripts/**"]',
    '',
  ].join('\n'));
  write('.tenbo/scopes/dashboard/roadmap.yaml', 'items: []\n');
  write('.tenbo/scopes/dashboard/layers/data-layer/intent.md', '# Data Layer\n');
  write('.tenbo/scopes/dashboard/layers/data-layer/code-map.md', '# Data Map\n');
  write('.tenbo/scopes/dashboard/layers/cli-tools/intent.md', '# CLI Tools\n');
  write('.tenbo/scopes/dashboard/layers/cli-tools/code-map.md', '# CLI Map\n');
  write('.tenbo/scopes/skill/architecture.yaml', [
    'layers:',
    '  - id: core-logic',
    '    name: Core Logic',
    '    description: Skill logic',
    '    files: ["src/**"]',
    '',
  ].join('\n'));
  write('.tenbo/scopes/skill/roadmap.yaml', 'items: []\n');
  write('.tenbo/scopes/skill/layers/core-logic/intent.md', '# Core Logic\n');
  write('.tenbo/scopes/skill/layers/core-logic/code-map.md', '# Core Map\n');
  write('tenbo-dashboard/tsconfig.json', JSON.stringify({
    compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler' },
    include: ['src', 'scripts'],
  }));
  write('skill/tsconfig.json', JSON.stringify({
    compilerOptions: {
      module: 'esnext',
      target: 'es2020',
      moduleResolution: 'bundler',
      baseUrl: '.',
      paths: { '@skill/*': ['src/*'] },
    },
    include: ['src'],
  }));
  write('tenbo-dashboard/src/api/lib/b.ts', 'export const beta = 1;\nexport function runBeta() { return beta; }\n');
  write('tenbo-dashboard/src/api/lib/a.ts', "import { beta } from './b';\nexport const alpha = beta;\n");
  write('tenbo-dashboard/scripts/context.ts', "import { alpha } from '../src/api/lib/a';\nexport const command = alpha;\n");
  write('skill/src/helper.ts', 'export const helper = true;\n');
  write('skill/src/use.ts', "import { helper } from '@skill/helper';\nexport const useHelper = helper;\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildSourceIndex', () => {
  it('indexes ownership hashes tokens imports exports symbols and line counts', () => {
    const index = buildSourceIndex(dir, { now: new Date('2026-06-30T00:00:00.000Z') });

    expect(index.schema_version).toBe(SOURCE_INDEX_SCHEMA_VERSION);
    expect(index.generated_at).toBe('2026-06-30T00:00:00.000Z');
    expect(Object.keys(index.inputs)).toEqual(expect.arrayContaining([
      '.tenbo/workspace.yaml',
      '.tenbo/scopes/dashboard/architecture.yaml',
      'tenbo-dashboard/src/api/lib/a.ts',
      'tenbo-dashboard/src/api/lib/b.ts',
      'tenbo-dashboard/scripts/context.ts',
    ]));
    const a = index.files.find((file) => file.path === 'tenbo-dashboard/src/api/lib/a.ts');
    const b = index.files.find((file) => file.path === 'tenbo-dashboard/src/api/lib/b.ts');
    const cli = index.files.find((file) => file.path === 'tenbo-dashboard/scripts/context.ts');
    const skillUse = index.files.find((file) => file.path === 'skill/src/use.ts');
    const skillHelper = index.files.find((file) => file.path === 'skill/src/helper.ts');

    expect(a).toMatchObject({
      scope: 'dashboard',
      layers: ['data-layer'],
      kind: 'source',
      imports: ['tenbo-dashboard/src/api/lib/b.ts'],
      exports: ['alpha'],
      symbols: expect.arrayContaining(['alpha']),
      line_count: 2,
    });
    expect(a?.tokens).toEqual(expect.arrayContaining(['api', 'lib', 'alpha']));
    expect(b?.imported_by).toEqual(expect.arrayContaining(['tenbo-dashboard/src/api/lib/a.ts']));
    expect(b?.exports).toEqual(expect.arrayContaining(['beta', 'runBeta']));
    expect(cli).toMatchObject({
      scope: 'dashboard',
      layers: ['cli-tools'],
      kind: 'source',
      imports: ['tenbo-dashboard/src/api/lib/a.ts'],
    });
    expect(skillUse).toMatchObject({
      scope: 'skill',
      layers: ['core-logic'],
      kind: 'source',
      imports: ['skill/src/helper.ts'],
    });
    expect(skillHelper?.imported_by).toEqual(['skill/src/use.ts']);
    expect(index.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'dashboard',
        layer: 'data-layer',
        files: expect.arrayContaining(['tenbo-dashboard/src/api/lib/a.ts', 'tenbo-dashboard/src/api/lib/b.ts']),
      }),
      expect.objectContaining({
        scope: 'dashboard',
        layer: 'cli-tools',
        files: ['tenbo-dashboard/scripts/context.ts'],
      }),
      expect.objectContaining({
        scope: 'skill',
        layer: 'core-logic',
        files: expect.arrayContaining(['skill/src/helper.ts', 'skill/src/use.ts']),
      }),
    ]));
  });
});
