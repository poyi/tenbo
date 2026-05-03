import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLayerContent } from './tenboFs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-lc-'));
  const layer = path.join(dir, '.tenbo', 'scopes', 'editor', 'layers', 'foo');
  mkdirSync(layer, { recursive: true });
  writeFileSync(path.join(layer, 'README.md'), '# Foo\n');
  writeFileSync(path.join(layer, 'intent.md'), '# Intent\n');
  writeFileSync(path.join(layer, 'code-map.md'), '# Code Map\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readLayerContent', () => {
  it('returns the three layer files', () => {
    const r = readLayerContent(dir, 'editor', 'foo');
    expect(r.scope).toBe('editor');
    expect(r.layer).toBe('foo');
    expect(r.readme).toContain('Foo');
    expect(r.intentMd).toContain('Intent');
    expect(r.codeMapMd).toContain('Code Map');
  });

  it('returns empty strings when files are missing', () => {
    const r = readLayerContent(dir, 'editor', 'missing');
    expect(r.readme).toBe('');
    expect(r.intentMd).toBe('');
    expect(r.codeMapMd).toBe('');
  });
});
