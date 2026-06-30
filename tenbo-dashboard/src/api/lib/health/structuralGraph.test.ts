import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildStructuralGraph } from './structuralGraph';

function makeTSConfig(root: string) {
  writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'esnext', target: 'es2020', moduleResolution: 'bundler', strict: false },
    include: ['**/*.ts'],
  }));
}

describe('buildStructuralGraph', () => {
  it('records imports exports and layer ownership', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'structural-graph-'));
    makeTSConfig(root);
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src/a.ts'), `import { runApp } from './b';\nexport const a = runApp;`);
    writeFileSync(path.join(root, 'src/b.ts'), `export function runApp() { return true; }\nexport const value = 1;`);
    const layerOfFile = new Map([['src/a.ts', 'app'], ['src/b.ts', 'data']]);

    const graph = buildStructuralGraph(root, ['src/a.ts', 'src/b.ts'], { layerOfFile });

    expect(graph.importsFrom('src/a.ts')).toEqual(['src/b.ts']);
    expect(graph.importedBy('src/b.ts')).toEqual(['src/a.ts']);
    expect(graph.allFiles()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(graph.layerFor('src/a.ts')).toBe('app');
    expect(graph.exportsFrom('src/b.ts')).toEqual(['runApp', 'value']);
    rmSync(root, { recursive: true, force: true });
  });
});
