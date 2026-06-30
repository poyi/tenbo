import { Project } from 'ts-morph';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { SourceIndex } from '../sourceIndex/types';

export interface StructuralGraph {
  importsFrom(file: string): string[];
  importedBy(file: string): string[];
  allFiles(): string[];
  layerFor(file: string): string | undefined;
  exportsFrom(file: string): string[];
}

export interface BuildStructuralGraphOptions {
  tsConfigFilePath?: string;
  layerOfFile?: Map<string, string>;
}

export function buildStructuralGraph(
  repoRoot: string,
  files: string[],
  options: BuildStructuralGraphOptions = {},
): StructuralGraph {
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
  const exported = new Map<string, Set<string>>();
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
      if (!target) continue;
      addEdge(fromRel, target.getFilePath());
    }
    for (const decl of sf.getExportDeclarations()) {
      const target = decl.getModuleSpecifierSourceFile();
      if (!target) continue;
      addEdge(fromRel, target.getFilePath());
    }
    for (const name of sf.getExportedDeclarations().keys()) {
      ensure(exported, fromRel).add(name);
    }
  }

  return {
    importsFrom: (f) => Array.from(fwd.get(f) ?? []),
    importedBy: (f) => Array.from(bwd.get(f) ?? []),
    allFiles: () => files,
    layerFor: (f) => options.layerOfFile?.get(f),
    exportsFrom: (f) => Array.from(exported.get(f) ?? []),
  };
}

export function graphFromSourceIndex(index: SourceIndex, scopeId?: string): StructuralGraph {
  const files = index.files.filter((file) => !scopeId || file.scope === scopeId);
  const byPath = new Map(files.map((file) => [file.path, file]));
  return {
    importsFrom: (f) => byPath.get(f)?.imports.filter((target) => byPath.has(target)) ?? [],
    importedBy: (f) => byPath.get(f)?.imported_by.filter((source) => byPath.has(source)) ?? [],
    allFiles: () => files.map((file) => file.path),
    layerFor: (f) => byPath.get(f)?.layers[0],
    exportsFrom: (f) => byPath.get(f)?.exports ?? [],
  };
}
