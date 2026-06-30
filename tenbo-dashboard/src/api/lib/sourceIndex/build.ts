import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readState } from '../tenboFs';
import { resolveLayerFiles } from '../health/layerFiles';
import { buildStructuralGraph } from '../health/structuralGraph';
import { computeSourceIndexInputs, SOURCE_INDEX_SCHEMA_VERSION } from './store';
import type { Scope } from '../../../types';
import type { SourceFileKind, SourceIndex, SourceIndexFile, SourceIndexLayer } from './types';

const TOKEN_LIMIT = 80;
const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/;

interface BuildSourceIndexOptions {
  now?: Date;
}

function tokenize(text: string): string[] {
  return Array.from(new Set(text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)))
    .slice(0, TOKEN_LIMIT);
}

function readText(repoRoot: string, rel: string): string {
  try { return readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { return ''; }
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).filter((_, index, lines) => index < lines.length - 1 || lines[index] !== '').length;
}

function kindForPath(rel: string): SourceFileKind {
  if (/\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(rel)) return 'test';
  if (rel.startsWith('.tenbo/specs/') || rel.includes('/specs/')) return 'spec';
  if (rel.endsWith('.md')) return 'docs';
  if (/(^|\/)(package|tsconfig|vite\.config|vitest\.config)/.test(rel) || /\.(ya?ml|json)$/.test(rel)) return 'config';
  if (SOURCE_EXT_RE.test(rel)) return 'source';
  return 'unknown';
}

function tsConfigForScope(repoRoot: string, scope: Scope): string | undefined {
  const scoped = path.join(repoRoot, scope.path || '.', 'tsconfig.json');
  if (existsSync(scoped)) return scoped;
  const root = path.join(repoRoot, 'tsconfig.json');
  return existsSync(root) ? root : undefined;
}

function publicEntrypoints(files: string[]): string[] {
  return files.filter((file) => /(^|\/)index\.tsx?$/.test(file)).sort();
}

function scopeOwnership(repoRoot: string, scope: Scope) {
  const filesByLayer = resolveLayerFiles(repoRoot, scope);
  const layerByFile = new Map<string, string[]>();
  for (const [layerId, files] of Object.entries(filesByLayer)) {
    for (const file of files) {
      const layers = layerByFile.get(file) ?? [];
      layers.push(layerId);
      layerByFile.set(file, layers);
    }
  }
  return { filesByLayer, layerByFile };
}

export function buildSourceIndex(repoRoot: string, options: BuildSourceIndexOptions = {}): SourceIndex {
  const state = readState(repoRoot);
  const warnings: string[] = [];
  const indexedFiles = new Map<string, { scope: string; layers: string[] }>();
  const indexLayers: SourceIndexLayer[] = [];
  const graphFilesByScope = new Map<string, string[]>();
  const layerOfFileByScope = new Map<string, Map<string, string>>();
  const graphByFile = new Map<string, ReturnType<typeof buildStructuralGraph>>();

  for (const scope of state.scopes) {
    const { filesByLayer, layerByFile } = scopeOwnership(repoRoot, scope);
    const graphFiles: string[] = [];
    const layerOfFile = new Map<string, string>();
    for (const [file, layers] of layerByFile.entries()) {
      indexedFiles.set(file, { scope: scope.id, layers: layers.sort() });
      if (SOURCE_EXT_RE.test(file)) graphFiles.push(file);
      if (layers[0]) layerOfFile.set(file, layers[0]);
    }
    graphFilesByScope.set(scope.id, graphFiles.sort());
    layerOfFileByScope.set(scope.id, layerOfFile);
    for (const [layerId, files] of Object.entries(filesByLayer)) {
      const layer = scope.layers.find((entry) => entry.id === layerId);
      indexLayers.push({
        scope: scope.id,
        layer: layerId,
        files: files.sort(),
        public_entrypoints: publicEntrypoints(files),
        tokens: tokenize([scope.id, scope.path, scope.description, layerId, layer?.name, layer?.description, ...files].join(' ')),
      });
    }
  }

  for (const scope of state.scopes) {
    const graphFiles = graphFilesByScope.get(scope.id) ?? [];
    if (graphFiles.length === 0) continue;
    try {
      const graph = buildStructuralGraph(repoRoot, graphFiles, {
        tsConfigFilePath: tsConfigForScope(repoRoot, scope),
        layerOfFile: layerOfFileByScope.get(scope.id),
      });
      for (const file of graphFiles) graphByFile.set(file, graph);
    } catch (err) {
      warnings.push(`could not build import graph for ${scope.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const files: SourceIndexFile[] = [];
  for (const [file, ownership] of Array.from(indexedFiles.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    const text = readText(repoRoot, file);
    const graph = graphByFile.get(file);
    const exports = graph?.exportsFrom(file).sort() ?? [];
    files.push({
      path: file,
      scope: ownership.scope,
      layers: ownership.layers,
      kind: kindForPath(file),
      tokens: tokenize(`${file} ${text}`),
      exports,
      imports: graph?.importsFrom(file).sort() ?? [],
      imported_by: graph?.importedBy(file).sort() ?? [],
      symbols: exports,
      line_count: lineCount(text),
    });
  }

  const inputPaths = unique([
    '.tenbo/workspace.yaml',
    '.tenbo/overview.md',
    ...state.scopes.flatMap((scope) => [
      `.tenbo/scopes/${scope.id}/architecture.yaml`,
      ...scope.layers.flatMap((layer) => [
        `.tenbo/scopes/${scope.id}/layers/${layer.id}/intent.md`,
        `.tenbo/scopes/${scope.id}/layers/${layer.id}/code-map.md`,
      ]),
    ]),
    ...files.map((file) => file.path),
  ]);

  return {
    schema_version: SOURCE_INDEX_SCHEMA_VERSION,
    generated_at: (options.now ?? new Date()).toISOString(),
    repo_root_fingerprint: path.basename(repoRoot),
    inputs: computeSourceIndexInputs(repoRoot, inputPaths),
    files,
    layers: indexLayers.sort((a, b) => a.scope.localeCompare(b.scope) || a.layer.localeCompare(b.layer)),
    warnings,
  };
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
