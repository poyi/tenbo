import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { scanForRelated } from '../../src/api/lib/frontmatterScan';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fm-'));
  mkdirSync(path.join(dir, 'docs/superpowers/plans'), { recursive: true });
  writeFileSync(path.join(dir, 'docs/superpowers/plans/a.md'),
    '---\ntenbo_item: rm-010\n---\n# Plan A\n');
  writeFileSync(path.join(dir, 'docs/superpowers/plans/b.md'),
    '---\nname: noop\n---\n# Plan B\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('frontmatterScan', () => {
  it('finds files tagged with tenbo_item', () => {
    const docs = scanForRelated(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0].itemId).toBe('rm-010');
    expect(docs[0].path).toContain('docs/superpowers/plans/a.md');
    expect(docs[0].title).toBe('Plan A');
  });
});
