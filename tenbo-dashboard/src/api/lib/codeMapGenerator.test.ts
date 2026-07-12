import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildSourceIndex } from './sourceIndex/build';
import { writeSourceIndex } from './sourceIndex/store';
import {
  buildStructuralBlock,
  CODE_MAP_MARKER_BEGIN,
  CODE_MAP_MARKER_END,
  generateCodeMaps,
  isCodeMapGeneratorError,
  layerContentHash,
  upsertMarkedRegion,
} from './codeMapGenerator';
import { readState } from './tenboFs';
import type { Layer, Scope } from '../../types';
import type { SourceIndex, SourceIndexFile, SourceIndexLayer } from './sourceIndex/types';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-code-map-gen-'));
  write('.tenbo/workspace.yaml', [
    'scopes:',
    '  - id: dashboard',
    '    path: tenbo-dashboard',
    '    description: dashboard scope',
    'cross_cutting: []',
    '',
  ].join('\n'));
  write('.tenbo/overview.md', '# Overview\n');
  write('.tenbo/scopes/dashboard/architecture.yaml', [
    'layers:',
    '  - id: data-layer',
    '    name: Data Layer',
    '    description: Data helpers',
    '    files: ["src/api/**"]',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: CLI helpers',
    '    files: ["scripts/**"]',
    '',
  ].join('\n'));
  write('.tenbo/scopes/dashboard/roadmap.yaml', 'items: []\n');
  write('.tenbo/scopes/dashboard/layers/data-layer/intent.md', '# Data Layer\n');
  write(
    '.tenbo/scopes/dashboard/layers/data-layer/code-map.md',
    '# Data Layer — Code Map\n\nHand-written intro that must survive regeneration.\n\n## Gotchas\n- Watch out for X.\n',
  );
  write('.tenbo/scopes/dashboard/layers/cli-tools/intent.md', '# CLI Tools\n');
  // No code-map.md for cli-tools yet — exercises the "insert marker" path.

  write('tenbo-dashboard/tsconfig.json', JSON.stringify({
    compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler' },
    include: ['src', 'scripts'],
  }));
  // data-layer: index.ts (explicit entrypoint) re-exported by helper.ts (fan-in from within layer).
  write('tenbo-dashboard/src/api/index.ts', "export { helper } from './helper';\n");
  write('tenbo-dashboard/src/api/helper.ts', 'export function helper() { return 1; }\n');
  // cli-tools: a script that imports the data-layer helper (cross-layer edge).
  write('tenbo-dashboard/scripts/run.ts', "import { helper } from '../src/api/helper';\nexport const runHelper = helper;\n");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function buildAndWriteIndex(): SourceIndex {
  const index = buildSourceIndex(dir, { now: new Date('2026-07-01T00:00:00.000Z') });
  writeSourceIndex(dir, index);
  return index;
}

describe('buildStructuralBlock', () => {
  it('is deterministic and reports entry points, files, and dependency edges', () => {
    const index = buildAndWriteIndex();
    const state = readState(dir);
    const scope = state.scopes.find((s) => s.id === 'dashboard')!;
    const dataLayer = scope.layers.find((l) => l.id === 'data-layer')!;

    const first = buildStructuralBlock(index, scope, dataLayer);
    const second = buildStructuralBlock(index, scope, dataLayer);
    expect(first.body).toBe(second.body);
    expect(first.hash).toBe(layerContentHash(index, scope, dataLayer));

    expect(first.body).toContain('### Entry points (auto)');
    expect(first.body).toContain('tenbo-dashboard/src/api/index.ts` — public entrypoint');
    expect(first.body).toContain('### Files (auto)');
    expect(first.body).toContain('tenbo-dashboard/src/api/helper.ts');
    expect(first.body).toContain('`helper`');
    expect(first.body).toContain('### Dependency edges (auto)');
    expect(first.body).toContain('tenbo-dashboard/src/api/index.ts` → `tenbo-dashboard/src/api/helper.ts`');
  });

  it('reports the cli-tools -> data-layer cross-layer edge', () => {
    const index = buildAndWriteIndex();
    const state = readState(dir);
    const scope = state.scopes.find((s) => s.id === 'dashboard')!;
    const cliTools = scope.layers.find((l) => l.id === 'cli-tools')!;

    const { body } = buildStructuralBlock(index, scope, cliTools);
    expect(body).toContain('tenbo-dashboard/scripts/run.ts` → data-layer:`tenbo-dashboard/src/api/helper.ts`');
  });
});

describe('upsertMarkedRegion — byte-for-byte prose preservation', () => {
  it('preserves hand-written prose above and below the marker byte-for-byte on insert and on regenerate', () => {
    const before = '# My Layer — Code Map\n\nIntro prose that an agent wrote by hand.\n\n## Gotchas\n- careful with race conditions\n';
    const blockA = 'line one\nline two';
    const inserted = upsertMarkedRegion(before, blockA, 'My Layer');
    expect(inserted.hadMarker).toBe(false);
    expect(inserted.changed).toBe(true);
    // Inserted after the title, but every prose byte from `before` still appears verbatim.
    expect(inserted.content).toContain('Intro prose that an agent wrote by hand.\n\n## Gotchas\n- careful with race conditions\n');
    expect(inserted.content).toContain(CODE_MAP_MARKER_BEGIN);
    expect(inserted.content).toContain(CODE_MAP_MARKER_END);

    // Regenerate with different structural content — everything outside the
    // marker pair must be byte-identical to the first insert's before/after.
    const blockB = 'line one changed\nline three';
    const regenerated = upsertMarkedRegion(inserted.content, blockB, 'My Layer');
    expect(regenerated.hadMarker).toBe(true);
    expect(regenerated.changed).toBe(true);

    const stripRegion = (text: string) => {
      const beginIdx = text.indexOf(CODE_MAP_MARKER_BEGIN);
      const endIdx = text.indexOf(CODE_MAP_MARKER_END);
      return text.slice(0, beginIdx) + text.slice(endIdx + CODE_MAP_MARKER_END.length);
    };
    expect(stripRegion(regenerated.content)).toBe(stripRegion(inserted.content));
    expect(regenerated.content).toContain('line one changed');
    expect(regenerated.content).not.toContain('line two');
  });

  it('is idempotent: re-running with the same block produces no change', () => {
    const before = '# Layer — Code Map\n\nProse.\n';
    const block = 'stable content';
    const first = upsertMarkedRegion(before, block, 'Layer');
    const second = upsertMarkedRegion(first.content, block, 'Layer');
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it('inserts at the top when there is no title line', () => {
    const before = 'Just some prose, no heading.\n';
    const result = upsertMarkedRegion(before, 'block body', 'Fallback');
    expect(result.hadMarker).toBe(false);
    expect(result.content).toContain('Just some prose, no heading.');
    expect(result.content.indexOf(CODE_MAP_MARKER_BEGIN)).toBeLessThan(result.content.indexOf('Just some prose'));
  });

  it('synthesizes a title when the file is empty', () => {
    const result = upsertMarkedRegion('', 'block body', 'New Layer');
    expect(result.content).toBe('# New Layer — Code Map\n\n<!-- tenbo:auto:code-map begin -->\nblock body\n<!-- tenbo:auto:code-map end -->\n');
  });

  it('preserves a normal single well-formed pair (regression)', () => {
    const before = [
      '# Layer — Code Map',
      '',
      'Hand-written intro.',
      '',
      CODE_MAP_MARKER_BEGIN,
      'stale block',
      CODE_MAP_MARKER_END,
      '',
      '## Gotchas',
      '- careful here',
      '',
    ].join('\n');
    const result = upsertMarkedRegion(before, 'fresh block', 'Layer');
    expect(result.hadMarker).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.content).toContain('Hand-written intro.');
    expect(result.content).toContain('## Gotchas\n- careful here');
    expect(result.content).toContain('fresh block');
    expect(result.content).not.toContain('stale block');
  });
});

describe('upsertMarkedRegion — marker safety (BLOCKER regression)', () => {
  it('does NOT corrupt hand-written prose when the marker text appears inside a fenced example above the real region — errors instead of guessing', () => {
    // A code-map.md that documents the marker syntax inside a fenced example
    // ABOVE the real generated block. Naive substring/indexOf-based matching
    // finds the marker text inside the fence FIRST and overwrites the
    // hand-written example, leaving the real trailing region stale forever.
    const exampleProse = [
      '# My Layer — Code Map',
      '',
      'This project uses auto-generated marker regions. For example:',
      '',
      '```md',
      CODE_MAP_MARKER_BEGIN,
      'example content — DO NOT TOUCH, this is hand-written documentation prose',
      CODE_MAP_MARKER_END,
      '```',
      '',
      'The real region is below.',
      '',
    ].join('\n');
    const realRegion = [
      CODE_MAP_MARKER_BEGIN,
      'real stale block',
      CODE_MAP_MARKER_END,
      '',
    ].join('\n');
    const before = exampleProse + realRegion;

    expect(() => upsertMarkedRegion(before, 'fresh block', 'My Layer')).toThrowError();
    try {
      upsertMarkedRegion(before, 'fresh block', 'My Layer');
      expect.unreachable();
    } catch (err) {
      expect(isCodeMapGeneratorError(err)).toBe(true);
      if (isCodeMapGeneratorError(err)) {
        expect(err.code).toBe('ambiguous_markers');
        expect(err.message).toContain('ambiguous');
      }
    }

    // Assert the hand-written example bytes survive verbatim — the whole
    // point is that nothing gets written when markers are ambiguous.
    expect(before).toContain('example content — DO NOT TOUCH, this is hand-written documentation prose');
  });

  it('errors loudly on a duplicate well-formed marker pair and writes nothing', () => {
    const before = [
      '# My Layer — Code Map',
      '',
      CODE_MAP_MARKER_BEGIN,
      'first pair',
      CODE_MAP_MARKER_END,
      '',
      'Some prose between the two pairs.',
      '',
      CODE_MAP_MARKER_BEGIN,
      'second pair',
      CODE_MAP_MARKER_END,
      '',
    ].join('\n');

    expect(() => upsertMarkedRegion(before, 'fresh block', 'My Layer')).toThrowError();
    try {
      upsertMarkedRegion(before, 'fresh block', 'My Layer');
      expect.unreachable();
    } catch (err) {
      expect(isCodeMapGeneratorError(err)).toBe(true);
      if (isCodeMapGeneratorError(err)) {
        expect(err.code).toBe('ambiguous_markers');
        expect(err.message).toContain('duplicate');
      }
    }
  });

  it('a marker mentioned mid-line (not on its own line) does not count as a real marker', () => {
    const before = [
      '# My Layer — Code Map',
      '',
      `Prose that mentions ${CODE_MAP_MARKER_BEGIN} inline, not on its own line.`,
      '',
    ].join('\n');
    // Zero *line-anchored* markers found -> falls through to the insert path,
    // not treated as a found-but-mismatched marker.
    const result = upsertMarkedRegion(before, 'fresh block', 'My Layer');
    expect(result.hadMarker).toBe(false);
    expect(result.content).toContain('Prose that mentions');
    expect(result.content).toContain(CODE_MAP_MARKER_BEGIN);
  });

  it('end-of-file-does-not-corrupt: generateCodeMaps leaves the on-disk file byte-identical when markers are ambiguous', () => {
    buildAndWriteIndex();
    const relPath = '.tenbo/scopes/dashboard/layers/data-layer/code-map.md';
    const corrupted = [
      '# Data Layer — Code Map',
      '',
      'Example of the marker syntax:',
      '',
      '```',
      CODE_MAP_MARKER_BEGIN,
      'fenced example — must survive untouched',
      CODE_MAP_MARKER_END,
      '```',
      '',
      CODE_MAP_MARKER_BEGIN,
      'real stale region',
      CODE_MAP_MARKER_END,
      '',
    ].join('\n');
    write(relPath, corrupted);

    expect(() => generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' })).toThrowError();

    const after = readFileSync(path.join(dir, relPath), 'utf8');
    expect(after).toBe(corrupted);
    expect(after).toContain('fenced example — must survive untouched');
  });
});

describe('generateCodeMaps', () => {
  it('writes only inside the marker for an existing code-map.md and leaves prose untouched', () => {
    buildAndWriteIndex();

    const result = generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });

    expect(result.mode).toBe('generate');
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]).toMatchObject({ scope: 'dashboard', layer: 'data-layer', had_marker: false, changed: true });

    const after = readFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/data-layer/code-map.md'), 'utf8');
    expect(after).toContain('Hand-written intro that must survive regeneration.');
    expect(after).toContain('- Watch out for X.');
    expect(after).toContain(CODE_MAP_MARKER_BEGIN);
  });

  it('creates a new code-map.md when none exists yet (cli-tools layer)', () => {
    buildAndWriteIndex();
    const result = generateCodeMaps(dir, { scope: 'dashboard', layer: 'cli-tools' });
    expect(result.layers[0].had_marker).toBe(false);
    expect(result.layers[0].changed).toBe(true);

    const content = readFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md'), 'utf8');
    expect(content).toContain('# CLI Tools — Code Map');
    expect(content).toContain(CODE_MAP_MARKER_BEGIN);
  });

  it('is a no-op on the second run (same index) — reports changed: false', () => {
    buildAndWriteIndex();
    generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });
    const second = generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });
    expect(second.layers[0].changed).toBe(false);
    expect(second.stale_layers).toEqual([]);
  });

  it('--check mode reports staleness without writing the file', () => {
    buildAndWriteIndex();
    const before = readFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/data-layer/code-map.md'), 'utf8');

    const result = generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer', check: true });
    expect(result.mode).toBe('check');
    expect(result.stale_layers).toEqual(['dashboard:data-layer']);

    const after = readFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/data-layer/code-map.md'), 'utf8');
    expect(after).toBe(before);
  });

  it('--check mode reports fresh (empty stale_layers) once generated', () => {
    buildAndWriteIndex();
    generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });
    const check = generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer', check: true });
    expect(check.stale_layers).toEqual([]);
    expect(check.layers[0].changed).toBe(false);
  });

  it('throws a clear, catchable error when the source index is missing', () => {
    expect(() => generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' })).toThrowError();
    try {
      generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });
      expect.unreachable();
    } catch (err) {
      expect(isCodeMapGeneratorError(err)).toBe(true);
      if (isCodeMapGeneratorError(err)) {
        expect(err.code).toBe('missing_source_index');
        expect(err.message).toContain('tenbo-dashboard index');
      }
    }
  });

  it('rebuilds the index automatically when stale, then generates from fresh data', () => {
    const index = buildAndWriteIndex();
    const state = readState(dir);
    const scope = state.scopes.find((s) => s.id === 'dashboard')!;
    const dataLayer = scope.layers.find((l) => l.id === 'data-layer')!;
    // Simulate drift on an already-tracked input (freshness only re-hashes
    // previously-tracked paths, so editing an existing file — not adding a
    // new one — is what `checkSourceIndexFreshness` will actually flag).
    write('tenbo-dashboard/src/api/helper.ts', 'export function helper() { return 1; }\nexport function helperTwo() { return 2; }\n');

    const result = generateCodeMaps(dir, { scope: 'dashboard', layer: 'data-layer' });
    expect(result.layers[0].block).toContain('helperTwo');
    // Confirms the rebuild actually happened (hash differs from the stale snapshot).
    expect(result.layers[0].content_hash).not.toBe(layerContentHash(index, scope, dataLayer));
  });

  it('rejects an unknown scope or layer with a not_found error', () => {
    buildAndWriteIndex();
    expect(() => generateCodeMaps(dir, { scope: 'nope' })).toThrowError();
    expect(() => generateCodeMaps(dir, { layer: 'nope' })).toThrowError();
  });

  it('selects all layers across all scopes when no filters are given', () => {
    buildAndWriteIndex();
    const result = generateCodeMaps(dir, {});
    const keys = result.layers.map((l) => `${l.scope}:${l.layer}`).sort();
    expect(keys).toEqual(['dashboard:cli-tools', 'dashboard:data-layer']);
  });
});

describe('generateCodeMaps — per-layer hash isolation (SHOULD-FIX 2)', () => {
  it('editing a file in one layer only marks that layer stale; the other layer is byte-identical', () => {
    buildAndWriteIndex();
    // Generate both layers once so each has a real, up-to-date code-map.md on disk.
    generateCodeMaps(dir, {});
    const cliToolsPathRel = '.tenbo/scopes/dashboard/layers/cli-tools/code-map.md';
    const dataLayerPathRel = '.tenbo/scopes/dashboard/layers/data-layer/code-map.md';
    const cliToolsBefore = readFileSync(path.join(dir, cliToolsPathRel), 'utf8');
    const dataLayerBefore = readFileSync(path.join(dir, dataLayerPathRel), 'utf8');

    // Edit a file that belongs ONLY to data-layer. cli-tools's own file
    // (scripts/run.ts) has a cross-layer edge INTO helper.ts, but nothing
    // about cli-tools's own files/exports/imports changes.
    write(
      'tenbo-dashboard/src/api/helper.ts',
      'export function helper() { return 1; }\nexport function helperTwo() { return 2; }\n',
    );

    const result = generateCodeMaps(dir, {});
    const staleKeys = result.stale_layers.sort();
    expect(staleKeys).toEqual(['dashboard:data-layer']);

    const cliToolsResult = result.layers.find((l) => l.layer === 'cli-tools')!;
    const dataLayerResult = result.layers.find((l) => l.layer === 'data-layer')!;
    expect(cliToolsResult.changed).toBe(false);
    expect(dataLayerResult.changed).toBe(true);

    const cliToolsAfter = readFileSync(path.join(dir, cliToolsPathRel), 'utf8');
    const dataLayerAfter = readFileSync(path.join(dir, dataLayerPathRel), 'utf8');
    expect(cliToolsAfter).toBe(cliToolsBefore);
    expect(dataLayerAfter).not.toBe(dataLayerBefore);
    expect(dataLayerAfter).toContain('helperTwo');
  });
});

describe('layerContentHash', () => {
  it('is unaffected by content of files that belong to a different layer', () => {
    const index = buildAndWriteIndex();
    const state = readState(dir);
    const scope = state.scopes.find((s) => s.id === 'dashboard')!;
    const dataLayer = scope.layers.find((l) => l.id === 'data-layer')!;
    const cliTools = scope.layers.find((l) => l.id === 'cli-tools')!;

    const dataLayerHashBefore = layerContentHash(index, scope, dataLayer);
    const cliToolsHashBefore = layerContentHash(index, scope, cliTools);

    write('tenbo-dashboard/scripts/run.ts', "import { helper } from '../src/api/helper';\nexport const runHelperAgain = helper;\n");
    const rebuilt = buildSourceIndex(dir, { now: new Date('2026-07-02T00:00:00.000Z') });

    expect(layerContentHash(rebuilt, scope, cliTools)).not.toBe(cliToolsHashBefore);
    expect(layerContentHash(rebuilt, scope, dataLayer)).toBe(dataLayerHashBefore);
  });
});

describe('buildStructuralBlock — cap enforcement (SHOULD-FIX 3)', () => {
  // Synthetic 200-file layer, built directly as a SourceIndex (no disk I/O)
  // so the caps (ENTRY_POINT_CAP=8, FILES_CAP=150, EXPORTS_PER_FILE_CAP=6,
  // EDGES_CAP=60) can be exercised precisely and deterministically.
  function buildBigLayerFixture() {
    const scope: Scope = { id: 'big-scope', path: 'big', description: '', layers: [], items: [] };
    const layer: Layer = { id: 'big-layer', name: 'Big Layer', description: '', files: ['pkg/**'] };
    scope.layers = [layer];

    const files: SourceIndexFile[] = [];
    const baseFile = (path_: string): SourceIndexFile => ({
      path: path_,
      scope: scope.id,
      layers: [layer.id],
      kind: 'source',
      tokens: [],
      exports: [],
      imports: [],
      imported_by: [],
      symbols: [],
      line_count: 10,
    });

    // 1 explicit entrypoint.
    files.push({ ...baseFile('pkg/index.ts'), exports: ['main'] });

    // 12 "hub" files, each with 9 exports (> EXPORTS_PER_FILE_CAP=6) and a
    // decreasing, distinct fan-in count (20, 19, ..., 9) so entry-point
    // ranking is unambiguous: top 7 by fan-in survive the cap alongside the
    // 1 explicit entrypoint (8 total).
    const hubCount = 12;
    const hubImporterCounts: number[] = [];
    for (let h = 0; h < hubCount; h++) hubImporterCounts.push(20 - h);
    const hubPath = (h: number) => `pkg/hub${String(h).padStart(2, '0')}.ts`;
    for (let h = 0; h < hubCount; h++) {
      files.push({
        ...baseFile(hubPath(h)),
        exports: Array.from({ length: 9 }, (_, i) => `hub${h}Export${i}`),
      });
    }

    // Leaf files: each imports exactly one hub, contributing one intra-layer
    // edge and one unit of fan-in to that hub.
    const leafFiles: SourceIndexFile[] = [];
    let leafIndex = 0;
    for (let h = 0; h < hubCount; h++) {
      for (let i = 0; i < hubImporterCounts[h]; i++) {
        const leafPath = `pkg/leaf${String(leafIndex).padStart(3, '0')}.ts`;
        leafFiles.push({ ...baseFile(leafPath), imports: [hubPath(h)] });
        leafIndex++;
      }
    }
    const totalLeaves = leafFiles.length; // 20+19+...+9 = 174

    // Filler files with no imports/exports, just to pad file count to 200.
    const targetTotal = 200;
    const fillerCount = targetTotal - files.length - totalLeaves;
    const fillerFiles: SourceIndexFile[] = [];
    for (let i = 0; i < fillerCount; i++) {
      fillerFiles.push(baseFile(`pkg/zzfiller${String(i).padStart(3, '0')}.ts`));
    }

    const allFiles = [...files, ...leafFiles, ...fillerFiles];
    // imported_by is derived (mirrors what the real source index builder computes).
    const importedByMap = new Map<string, string[]>();
    for (const file of allFiles) {
      for (const target of file.imports) {
        const list = importedByMap.get(target) ?? [];
        list.push(file.path);
        importedByMap.set(target, list);
      }
    }
    for (const file of allFiles) {
      file.imported_by = (importedByMap.get(file.path) ?? []).sort();
    }

    expect(allFiles.length).toBe(targetTotal);

    const indexLayer: SourceIndexLayer = {
      scope: scope.id,
      layer: layer.id,
      files: allFiles.map((f) => f.path).sort(),
      public_entrypoints: ['pkg/index.ts'],
      tokens: [],
    };

    const index: SourceIndex = {
      schema_version: 1,
      generated_at: '2026-07-01T00:00:00.000Z',
      repo_root_fingerprint: 'big',
      inputs: {},
      files: allFiles,
      layers: [indexLayer],
      warnings: [],
    };

    return { index, scope, layer, hubCount, totalLeaves, targetTotal };
  }

  it('caps entry points at ENTRY_POINT_CAP(8): explicit entrypoint plus the top fan-in hubs', () => {
    const { index, scope, layer } = buildBigLayerFixture();
    const { body } = buildStructuralBlock(index, scope, layer);
    // Scope the line search to the Entry Points section only — edge lines
    // also start with "- `pkg/..." and would otherwise bleed in.
    const entrySection = body.slice(body.indexOf('### Entry points (auto)'), body.indexOf('### Files (auto)'));
    const entryLines = entrySection.split('\n').filter((line) => line.startsWith('- `'));
    expect(entryLines).toHaveLength(8);
    expect(entrySection).toContain('pkg/index.ts` — public entrypoint');
    // Top 7 hubs by fan-in (hub00..hub06, fan-in 20..14) survive; hub07 (fan-in 13) does not.
    for (let h = 0; h <= 6; h++) expect(entrySection).toContain(`pkg/hub${String(h).padStart(2, '0')}.ts\``);
    expect(entrySection).not.toContain('pkg/hub07.ts`');
    expect(entrySection).not.toContain('pkg/hub11.ts`');
  });

  it('caps the files table at FILES_CAP(150) with a correct "+N more" count', () => {
    const { index, scope, layer, targetTotal } = buildBigLayerFixture();
    const { body } = buildStructuralBlock(index, scope, layer);
    const fileRows = body.split('\n').filter((line) => line.startsWith('| `pkg/'));
    expect(fileRows).toHaveLength(150);
    expect(body).toContain(`_+${targetTotal - 150} more file(s) not shown (${targetTotal} total)._`);
  });

  it('caps exports per file at EXPORTS_PER_FILE_CAP(6) with a correct "+N more" suffix', () => {
    const { index, scope, layer } = buildBigLayerFixture();
    const { body } = buildStructuralBlock(index, scope, layer);
    // hub00 has 9 exports -> 6 shown + ", +3 more".
    const hubRow = body.split('\n').find((line) => line.startsWith('| `pkg/hub00.ts`'))!;
    expect(hubRow).toBeDefined();
    const shownExports = ['hub0Export0', 'hub0Export1', 'hub0Export2', 'hub0Export3', 'hub0Export4', 'hub0Export5'];
    for (const name of shownExports) expect(hubRow).toContain(`\`${name}\``);
    expect(hubRow).not.toContain('hub0Export6');
    expect(hubRow).toContain(', +3 more');
  });

  it('caps intra-layer edges at EDGES_CAP(60) with a correct "+N more" count', () => {
    const { index, scope, layer, totalLeaves } = buildBigLayerFixture();
    const { body } = buildStructuralBlock(index, scope, layer);
    const intraSection = body.slice(body.indexOf('**Intra-layer:**'), body.indexOf('**Cross-layer:**'));
    const edgeLines = intraSection.split('\n').filter((line) => line.startsWith('- `pkg/leaf'));
    expect(edgeLines).toHaveLength(60);
    expect(intraSection).toContain(`_+${totalLeaves - 60} more edge(s) not shown._`);
  });
});
