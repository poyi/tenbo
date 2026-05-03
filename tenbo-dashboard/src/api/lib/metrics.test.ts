import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeScopeMetrics, globMatches } from './metrics';
import type { Scope } from '../../types';

function tmp(structure: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'tenbo-metrics-'));
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('computeScopeMetrics', () => {
  it('counts files matching glob and totals lines', () => {
    const root = tmp({
      'src/a.ts': 'one\ntwo\nthree\n',
      'src/b.ts': 'one\n',
    });
    const scope: Scope = {
      id: 'e', path: '.', description: 'x',
      layers: [{ id: 'l', name: 'L', description: 'x', files: ['src/**/*.ts'], dependencies: { outbound: ['x'] } } as any],
      items: [],
    };
    const m = computeScopeMetrics(root, scope, {});
    expect(m.layers.l.file_count).toBe(2);
    expect(m.layers.l.total_lines).toBe(4);
    expect(m.layers.l.outbound_deps).toBe(1);
  });

  it('computes intent_age_days from layerDocs mtime', () => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const m = computeScopeMetrics('/x', {
      id: 'e', path: '.', description: 'x',
      layers: [{ id: 'l', name: 'L', description: 'x', files: [] } as any],
      items: [],
    }, { 'e/l': { hasIntent: true, hasCodeMap: false, intentMtime: sevenDaysAgo, codeMapMtime: null, intentEmpty: false } });
    expect(m.layers.l.intent_age_days).toBe(7);
  });

  it('matches `src/**/*.ts` across zero and many intermediate segments', () => {
    const root = tmp({
      'src/a.ts': 'x\n',
      'src/sub/b.ts': 'x\n',
      'src/sub/deep/c.ts': 'x\n',
    });
    const scope: Scope = {
      id: 'e', path: '.', description: 'x',
      layers: [{ id: 'l', name: 'L', description: 'x', files: ['src/**/*.ts'] } as any],
      items: [],
    };
    const m = computeScopeMetrics(root, scope, {});
    expect(m.layers.l.file_count).toBe(3);
  });
});

describe('globMatches', () => {
  it('handles `src/**/*.ts` with zero or many segments', () => {
    expect(globMatches('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/**/*.ts', 'src/sub/a.ts')).toBe(true);
    expect(globMatches('src/**/*.ts', 'src/sub/deep/a.ts')).toBe(true);
    expect(globMatches('src/**/*.ts', 'other/a.ts')).toBe(false);
  });

  it('handles leading `**/` matching root', () => {
    expect(globMatches('**/foo.ts', 'foo.ts')).toBe(true);
    expect(globMatches('**/foo.ts', 'dir/foo.ts')).toBe(true);
    expect(globMatches('**/foo.ts', 'dir/sub/foo.ts')).toBe(true);
  });

  it('honors `*` segment-non-crossing', () => {
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/sub/a.ts')).toBe(false);
    expect(globMatches('*.ts', 'a.ts')).toBe(true);
    expect(globMatches('*.ts', 'sub/a.ts')).toBe(false);
  });
});
