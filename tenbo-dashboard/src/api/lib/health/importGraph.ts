import { Project } from 'ts-morph';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ImportGraph {
  importsFrom(file: string): string[];
  importedBy(file: string): string[];
  allFiles(): string[];
}

export interface BuildImportGraphOptions {
  tsConfigFilePath?: string;
}

/**
 * Build an import graph for the given repo-relative TS/TSX files.
 * Resolution uses the repo's tsconfig if found at <repoRoot>/tsconfig.json,
 * otherwise a default config.
 */
export function buildImportGraph(repoRoot: string, files: string[], options: BuildImportGraphOptions = {}): ImportGraph {
  const tsconfigPath = options.tsConfigFilePath ?? path.join(repoRoot, 'tsconfig.json');
  const project = new Project({
    ...(existsSync(tsconfigPath) ? { tsConfigFilePath: tsconfigPath } : {}),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });
  const absFiles = files.map(f => path.resolve(repoRoot, f));
  project.addSourceFilesAtPaths(absFiles);

  const fwd = new Map<string, Set<string>>();
  const bwd = new Map<string, Set<string>>();
  const fileSet = new Set(files);
  const ensure = (m: Map<string, Set<string>>, k: string) => {
    let s = m.get(k);
    if (!s) { s = new Set(); m.set(k, s); }
    return s;
  };
  const addEdge = (fromRel: string, toAbs: string) => {
    const toRel = path.relative(repoRoot, toAbs).split(path.sep).join('/');
    if (!fileSet.has(toRel)) return;
    ensure(fwd, fromRel).add(toRel);
    ensure(bwd, toRel).add(fromRel);
  };

  for (const sf of project.getSourceFiles()) {
    const fromAbs = sf.getFilePath();
    const fromRel = path.relative(repoRoot, fromAbs).split(path.sep).join('/');
    if (!fileSet.has(fromRel)) continue;
    for (const decl of sf.getImportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target) continue; // external module
      addEdge(fromRel, target.getFilePath());
    }
    for (const decl of sf.getExportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target) continue; // export without module specifier or external module
      addEdge(fromRel, target.getFilePath());
    }
  }
  return {
    importsFrom: (f) => Array.from(fwd.get(f) ?? []),
    importedBy: (f) => Array.from(bwd.get(f) ?? []),
    allFiles: () => files,
  };
}
