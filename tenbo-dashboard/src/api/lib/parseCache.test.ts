import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getCached, invalidate, clearCache } from './parseCache';

describe('parseCache', () => {
  let dir: string;
  let file: string;
  let parseCount: number;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tenbo-parsecache-'));
    file = path.join(dir, 'sample.txt');
    parseCount = 0;
    clearCache();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function counter(s: string): { value: string } {
    parseCount += 1;
    return { value: s.trim() };
  }

  it('parses on first call, returns cached result on second', () => {
    writeFileSync(file, 'hello');
    const a = getCached(file, 'txt', counter);
    const b = getCached(file, 'txt', counter);
    expect(a.value).toBe('hello');
    expect(b).toBe(a);
    expect(parseCount).toBe(1);
  });

  it('re-parses when file content changes', () => {
    writeFileSync(file, 'first');
    const first = getCached(file, 'txt', counter);
    expect(first.value).toBe('first');

    // Force a future mtime so the fast-path re-checks the hash.
    const future = Date.now() / 1000 + 5;
    writeFileSync(file, 'second');
    require('node:fs').utimesSync(file, future, future);

    const second = getCached(file, 'txt', counter);
    expect(second.value).toBe('second');
    expect(parseCount).toBe(2);
  });

  it('keeps separate cache slots per signature', () => {
    writeFileSync(file, 'shared');
    getCached(file, 'parser-a', counter);
    getCached(file, 'parser-b', counter);
    expect(parseCount).toBe(2);
  });

  it('invalidate(path) drops cache entries for that path', () => {
    writeFileSync(file, 'hello');
    getCached(file, 'txt', counter);
    invalidate(file);
    getCached(file, 'txt', counter);
    expect(parseCount).toBe(2);
  });

  it('serves stale on transient parse failure (does not poison cache)', () => {
    writeFileSync(file, 'good');
    const ok = getCached(file, 'txt', (s) => {
      if (s === 'BAD') throw new Error('parse failed');
      return { value: s };
    });
    expect(ok.value).toBe('good');

    // Force a re-read by bumping mtime; parser will throw on the new content.
    const future = Date.now() / 1000 + 5;
    writeFileSync(file, 'BAD');
    require('node:fs').utimesSync(file, future, future);

    const stillOk = getCached(file, 'txt', (s) => {
      if (s === 'BAD') throw new Error('parse failed');
      return { value: s };
    });
    expect(stillOk.value).toBe('good'); // returned the previous good value
  });

  it('throws on first-ever parse failure (no previous good value to fall back to)', () => {
    writeFileSync(file, 'BAD');
    expect(() => {
      getCached(file, 'txt', (s) => {
        if (s === 'BAD') throw new Error('parse failed');
        return { value: s };
      });
    }).toThrow('parse failed');
  });
});
