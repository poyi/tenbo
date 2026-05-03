import { describe, it, expect } from 'vitest';
import { analyzeRedundancy } from './redundancy';
import { DEFAULT_HEALTH_CONFIG } from './config';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('analyzeRedundancy', () => {
  it('flags duplicated blocks across files', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dup-'));
    mkdirSync(path.join(root, 'src/A'), { recursive: true });
    mkdirSync(path.join(root, 'src/B'), { recursive: true });
    const block = Array.from({ length: 40 }, (_, i) => `  console.log("dup line ${i}");`).join('\n');
    const wrap = (b: string) => `export function f() {\n${b}\n}\n`;
    writeFileSync(path.join(root, 'src/A/foo.ts'), wrap(block));
    writeFileSync(path.join(root, 'src/B/bar.ts'), wrap(block));

    const filesByLayer = { A: ['src/A/foo.ts'], B: ['src/B/bar.ts'] };
    const findings = await analyzeRedundancy(root, filesByLayer, DEFAULT_HEALTH_CONFIG);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].signal).toBe('redundancy');
    rmSync(root, { recursive: true, force: true });
  }, 30000);
});
