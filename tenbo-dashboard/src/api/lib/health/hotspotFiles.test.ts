import { describe, it, expect } from 'vitest';
import { analyzeHotspotFiles } from './hotspotFiles';
import { DEFAULT_HEALTH_CONFIG } from './config';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function makeFile(root: string, rel: string, lines: number): string {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Array.from({ length: lines }, (_, i) => `// line ${i}`).join('\n'));
  return rel;
}

describe('analyzeHotspotFiles', () => {
  it('flags files exceeding LOC thresholds', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hotspot-'));
    const small = makeFile(root, 'small.ts', 100);
    const medium = makeFile(root, 'medium.ts', 350);
    const large = makeFile(root, 'large.ts', 700);
    const huge = makeFile(root, 'huge.ts', 1500);

    const findings = analyzeHotspotFiles(root, 'lyr', [small, medium, large, huge], DEFAULT_HEALTH_CONFIG);

    expect(findings.find(f => f.target === 'small.ts')).toBeUndefined();
    expect(findings.find(f => f.target === 'medium.ts')?.severity).toBe('info');
    expect(findings.find(f => f.target === 'large.ts')?.severity).toBe('warning');
    expect(findings.find(f => f.target === 'huge.ts')?.severity).toBe('critical');
    rmSync(root, { recursive: true, force: true });
  });

  it('respects ignore.hotspot_files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hotspot-'));
    const huge = makeFile(root, 'huge.ts', 1500);
    const cfg = { ...DEFAULT_HEALTH_CONFIG, ignore: { ...DEFAULT_HEALTH_CONFIG.ignore, hotspot_files: ['huge.ts'] } };
    const findings = analyzeHotspotFiles(root, 'lyr', [huge], cfg);
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('produces a structured suggestion with action_kind=split-file', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hotspot-'));
    const huge = makeFile(root, 'huge.ts', 1500);
    const findings = analyzeHotspotFiles(root, 'lyr', [huge], DEFAULT_HEALTH_CONFIG);
    expect(findings[0].suggestion.action_kind).toBe('split-file');
    expect(findings[0].details.kind).toBe('hotspot-files');
    rmSync(root, { recursive: true, force: true });
  });
});
