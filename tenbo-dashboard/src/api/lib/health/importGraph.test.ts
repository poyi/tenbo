import { describe, it, expect } from 'vitest';
import { buildImportGraph } from './importGraph';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function makeTSConfig(root: string) {
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler', allowJs: false, strict: false },
    include: ['**/*.ts'],
  }));
}

describe('buildImportGraph', () => {
  it('records import edges between files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'graph-'));
    makeTSConfig(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.ts'), `import { x } from './b';\nexport const a = x;`);
    writeFileSync(path.join(root, 'src/b.ts'), `export const x = 1;`);
    writeFileSync(path.join(root, 'src/c.ts'), `export const c = 2;`);

    const graph = buildImportGraph(root, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(graph.importsFrom('src/a.ts')).toContain('src/b.ts');
    expect(graph.importedBy('src/b.ts')).toContain('src/a.ts');
    expect(graph.importedBy('src/c.ts')).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});
