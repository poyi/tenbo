import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  SOURCE_INDEX_SCHEMA_VERSION,
  checkSourceIndexFreshness,
  readSourceIndex,
  sourceIndexPath,
  writeSourceIndex,
} from './store';
import type { SourceIndex } from './types';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function baseIndex(overrides: Partial<SourceIndex> = {}): SourceIndex {
  return {
    schema_version: SOURCE_INDEX_SCHEMA_VERSION,
    generated_at: '2026-06-30T00:00:00.000Z',
    repo_root_fingerprint: 'test-repo',
    inputs: {
      '.tenbo/workspace.yaml': 'old-workspace-hash',
      'src/a.ts': 'old-source-hash',
    },
    files: [],
    layers: [],
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-source-index-store-'));
  mkdirSync(path.join(dir, '.tenbo'), { recursive: true });
  write('.tenbo/workspace.yaml', 'scopes: []\n');
  write('src/a.ts', 'export const a = 1;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('source index store', () => {
  it('reports missing when no index artifact exists', () => {
    expect(readSourceIndex(dir)).toBeNull();
    expect(checkSourceIndexFreshness(dir).status).toBe('missing');
  });

  it('writes and reads the generated index artifact atomically', () => {
    const index = baseIndex();

    writeSourceIndex(dir, index);

    expect(existsSync(sourceIndexPath(dir))).toBe(true);
    expect(readSourceIndex(dir)).toEqual(index);
    expect(readFileSync(sourceIndexPath(dir), 'utf8')).toContain('"schema_version"');
  });

  it('creates a cache-local gitignore for generated artifacts', () => {
    writeSourceIndex(dir, baseIndex());

    expect(readFileSync(path.join(dir, '.tenbo/cache/.gitignore'), 'utf8')).toBe('*\n!.gitignore\n');
  });

  it('reports fresh when all indexed inputs still match', () => {
    const index = baseIndex({
      inputs: {
        '.tenbo/workspace.yaml': '',
        'src/a.ts': '',
      },
    });
    writeSourceIndex(dir, index);
    const current = readSourceIndex(dir);
    if (!current) throw new Error('expected index');
    current.inputs = checkSourceIndexFreshness(dir, current).current_inputs;
    writeSourceIndex(dir, current);

    expect(checkSourceIndexFreshness(dir).status).toBe('fresh');
  });

  it('reports stale when an indexed input changes', () => {
    const currentInputs = checkSourceIndexFreshness(dir, baseIndex()).current_inputs;
    writeSourceIndex(dir, baseIndex({ inputs: currentInputs }));
    write('src/a.ts', 'export const a = 2;\n');

    const freshness = checkSourceIndexFreshness(dir);

    expect(freshness.status).toBe('stale');
    expect(freshness.changed_inputs).toContain('src/a.ts');
  });

  it('reports corrupt when the index cannot be parsed', () => {
    write('.tenbo/cache/source-index.json', '{ not json');

    expect(readSourceIndex(dir)).toBeNull();
    expect(checkSourceIndexFreshness(dir).status).toBe('corrupt');
  });

  it('reports incompatible when schema version differs', () => {
    writeSourceIndex(dir, baseIndex({ schema_version: SOURCE_INDEX_SCHEMA_VERSION + 1 }));

    expect(checkSourceIndexFreshness(dir).status).toBe('incompatible');
  });
});
