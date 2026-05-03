import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { findRepoRoot } from '../../src/api/lib/repoRoot';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reporoot-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, 'sub/deeper'), { recursive: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('findRepoRoot', () => {
  it('returns the dir containing .git when starting from that dir', () => {
    expect(findRepoRoot(dir)).toBe(dir);
  });

  it('walks up to find the .git ancestor when starting from a subdirectory', () => {
    expect(findRepoRoot(path.join(dir, 'sub/deeper'))).toBe(dir);
  });

  it('returns null when no .git exists up the tree', () => {
    // tmpdir itself has no .git ancestor on a sane system
    expect(findRepoRoot(tmpdir())).toBeNull();
  });
});
