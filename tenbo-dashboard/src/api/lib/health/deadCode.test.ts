import { describe, it, expect } from 'vitest';
import { analyzeDeadCode } from './deadCode';
import { buildImportGraph } from './importGraph';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('analyzeDeadCode', () => {
  it('flags a file with zero importers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'dead-'));
    writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2020' }, include: ['**/*.ts'] }));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/used.ts'), `export const x = 1;`);
    writeFileSync(path.join(root, 'src/unused.ts'), `export const y = 1;`);
    writeFileSync(path.join(root, 'src/entry.ts'), `import { x } from './used';\nexport const z = x;`);
    const graph = buildImportGraph(root, ['src/entry.ts', 'src/used.ts', 'src/unused.ts']);

    const findings = analyzeDeadCode(root, 'lyr', ['src/used.ts', 'src/unused.ts'], graph);
    const unusedFinding = findings.find(f => f.target === 'src/unused.ts');
    expect(unusedFinding).toBeDefined();
    expect(unusedFinding?.suggestion.summary).toBe('Review unused.ts');
    expect(unusedFinding?.suggestion.action_kind).toBe('review-file');
    expect(unusedFinding?.details.kind === 'dead-code' ? unusedFinding.details.static_import_evidence : '').toContain('No repo-wide static import');
    expect(unusedFinding?.details.kind === 'dead-code' ? unusedFinding.details.exported_symbols : []).toEqual(['y']);
    expect(findings.find(f => f.target === 'src/used.ts')).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
