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

  it('resolves scope-local path aliases from the provided tsconfig', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'graph-alias-'));
    mkdirSync(path.join(root, 'apps/editor/src/shared'), { recursive: true });
    mkdirSync(path.join(root, 'apps/editor/src/domains/canvas/hooks'), { recursive: true });
    writeFileSync(path.join(root, 'apps/editor/tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'esnext',
        target: 'es2020',
        moduleResolution: 'bundler',
        baseUrl: '.',
        paths: { '@/*': ['./src/*'] },
        strict: false,
      },
      include: ['src'],
    }));
    writeFileSync(path.join(root, 'apps/editor/src/shared/View.ts'), `import { useCanvas } from '@/domains/canvas/hooks/useCanvas';\nexport const view = useCanvas;`);
    writeFileSync(path.join(root, 'apps/editor/src/domains/canvas/hooks/useCanvas.ts'), `export const useCanvas = () => null;`);

    const graph = buildImportGraph(root, [
      'apps/editor/src/shared/View.ts',
      'apps/editor/src/domains/canvas/hooks/useCanvas.ts',
    ], { tsConfigFilePath: path.join(root, 'apps/editor/tsconfig.json') });
    expect(graph.importedBy('apps/editor/src/domains/canvas/hooks/useCanvas.ts')).toContain('apps/editor/src/shared/View.ts');
    rmSync(root, { recursive: true, force: true });
  });

  it('counts barrel re-exports as inbound static edges', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'graph-barrel-'));
    makeTSConfig(root);
    mkdirSync(path.join(root, 'src/feature'), { recursive: true });
    writeFileSync(path.join(root, 'src/index.ts'), `export * from './feature/useThing';\nexport { named } from './feature/named';`);
    writeFileSync(path.join(root, 'src/feature/useThing.ts'), `export const useThing = () => null;`);
    writeFileSync(path.join(root, 'src/feature/named.ts'), `export const named = 1;`);

    const graph = buildImportGraph(root, [
      'src/index.ts',
      'src/feature/useThing.ts',
      'src/feature/named.ts',
    ]);
    expect(graph.importedBy('src/feature/useThing.ts')).toContain('src/index.ts');
    expect(graph.importedBy('src/feature/named.ts')).toContain('src/index.ts');
    rmSync(root, { recursive: true, force: true });
  });
});
