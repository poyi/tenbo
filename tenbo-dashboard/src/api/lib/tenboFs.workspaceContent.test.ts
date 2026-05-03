import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceContent } from './tenboFs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-ws-'));
  mkdirSync(path.join(dir, '.tenbo'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readWorkspaceContent', () => {
  it('returns empty strings and null mtimes when files are missing', () => {
    const r = readWorkspaceContent(dir);
    expect(r.principlesMd).toBe('');
    expect(r.glossaryMd).toBe('');
    expect(r.observationsMd).toBe('');
    expect(r.principlesMtime).toBeNull();
    expect(r.glossaryMtime).toBeNull();
    expect(r.observationsMtime).toBeNull();
  });

  it('reads contents and mtimes when files exist', () => {
    const fixedTime = new Date('2026-01-01T00:00:00Z');
    const tenbo = path.join(dir, '.tenbo');
    writeFileSync(path.join(tenbo, 'principles.md'), '# Principles\n');
    writeFileSync(path.join(tenbo, 'glossary.md'), '# Glossary\n');
    writeFileSync(path.join(tenbo, 'observations.md'), '# Observations\n');
    for (const f of ['principles.md', 'glossary.md', 'observations.md']) {
      utimesSync(path.join(tenbo, f), fixedTime, fixedTime);
    }
    const r = readWorkspaceContent(dir);
    expect(r.principlesMd).toContain('Principles');
    expect(r.glossaryMd).toContain('Glossary');
    expect(r.observationsMd).toContain('Observations');
    expect(r.principlesMtime).toBe(fixedTime.getTime());
  });
});
