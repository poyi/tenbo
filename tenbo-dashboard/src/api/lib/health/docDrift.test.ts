import { describe, it, expect } from 'vitest';
import { analyzeDocDrift, extractFileRefs } from './docDrift';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('extractFileRefs', () => {
  it('pulls inline-code-fenced paths from markdown', () => {
    const md = `Look at \`apps/editor/src/foo.ts\` and \`bar/baz.tsx\`.`;
    expect(extractFileRefs(md)).toEqual(['apps/editor/src/foo.ts', 'bar/baz.tsx']);
  });

  it('ignores prose with no file-like tokens', () => {
    expect(extractFileRefs('See the README. No paths here.')).toEqual([]);
  });
});

describe('analyzeDocDrift', () => {
  it('emits missing-ref finding when code-map.md references a file that does not exist', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'drift-'));
    mkdirSync(path.join(root, '.tenbo/scopes/editor/layers/lyr'), { recursive: true });
    writeFileSync(
      path.join(root, '.tenbo/scopes/editor/layers/lyr/code-map.md'),
      'See `apps/editor/src/missing.ts`.\n',
    );
    const findings = analyzeDocDrift(root, 'editor', 'lyr', []);
    const broken = findings.find(f =>
      f.details.kind === 'doc-drift' && f.details.drift_type === 'missing-ref'
    );
    expect(broken).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('does NOT emit missing-ref when file exists under the scope path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'drift-'));
    const scopePath = 'tenbo-dashboard';
    mkdirSync(path.join(root, scopePath, 'src'), { recursive: true });
    writeFileSync(path.join(root, scopePath, 'src/main.tsx'), 'export default 1;\n');
    mkdirSync(path.join(root, '.tenbo/scopes/dashboard/layers/lyr'), { recursive: true });
    writeFileSync(
      path.join(root, '.tenbo/scopes/dashboard/layers/lyr/code-map.md'),
      'Entry point: `src/main.tsx`.\n',
    );
    const findings = analyzeDocDrift(root, 'dashboard', 'lyr', [], scopePath);
    const broken = findings.find(f =>
      f.details.kind === 'doc-drift' && f.details.drift_type === 'missing-ref'
    );
    expect(broken).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it('emits unreferenced-file info finding when a layer file is not mentioned in code-map.md', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'drift-'));
    mkdirSync(path.join(root, 'apps/editor/src'), { recursive: true });
    writeFileSync(path.join(root, 'apps/editor/src/known.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(root, 'apps/editor/src/orphan.ts'), 'export const y = 1;\n');
    mkdirSync(path.join(root, '.tenbo/scopes/editor/layers/lyr'), { recursive: true });
    writeFileSync(
      path.join(root, '.tenbo/scopes/editor/layers/lyr/code-map.md'),
      'See `apps/editor/src/known.ts`.\n',
    );
    const findings = analyzeDocDrift(root, 'editor', 'lyr', [
      'apps/editor/src/known.ts',
      'apps/editor/src/orphan.ts',
    ]);
    const orphan = findings.find(f =>
      f.details.kind === 'doc-drift' && f.details.drift_type === 'unreferenced-file'
    );
    expect(orphan).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  });
});
