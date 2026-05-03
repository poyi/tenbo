import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { parse as parseSimple } from 'yaml';
import { parseYaml, stringifyYaml, patchSeqItem, reorderSeqItems } from './yamlOrdered';
import type { TenboState, Scope, Item, Layer, CrossCutting, LayerDocs, ScopeMetrics, WorkspaceContent, LayerContent } from '../../types';

function tenboDir(repoRoot: string) { return path.join(repoRoot, '.tenbo'); }

function readMaybeFile(p: string): { content: string; mtime: number | null } {
  if (!existsSync(p)) return { content: '', mtime: null };
  const content = readFileSync(p, 'utf8');
  const mtime = statSync(p).mtimeMs;
  return { content, mtime };
}

export function readWorkspaceContent(repoRoot: string): WorkspaceContent {
  const tenbo = tenboDir(repoRoot);
  const ov = readMaybeFile(path.join(tenbo, 'overview.md'));
  const p = readMaybeFile(path.join(tenbo, 'principles.md'));
  const g = readMaybeFile(path.join(tenbo, 'glossary.md'));
  const o = readMaybeFile(path.join(tenbo, 'observations.md'));
  return {
    overviewMd: ov.content,
    principlesMd: p.content,
    glossaryMd: g.content,
    observationsMd: o.content,
    overviewMtime: ov.mtime,
    principlesMtime: p.mtime,
    glossaryMtime: g.mtime,
    observationsMtime: o.mtime,
  };
}

export function readLayerContent(repoRoot: string, scopeId: string, layerId: string): LayerContent {
  const layerDir = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'layers', layerId);
  return {
    scope: scopeId,
    layer: layerId,
    readme: readMaybeFile(path.join(layerDir, 'README.md')).content,
    intentMd: readMaybeFile(path.join(layerDir, 'intent.md')).content,
    codeMapMd: readMaybeFile(path.join(layerDir, 'code-map.md')).content,
  };
}

export function tenboExists(repoRoot: string): boolean {
  return existsSync(path.join(tenboDir(repoRoot), 'workspace.yaml'));
}

export function readWorkspace(repoRoot: string): { scopeRefs: { id: string; path: string; description: string }[]; crossCutting: CrossCutting[] } {
  const text = readFileSync(path.join(tenboDir(repoRoot), 'workspace.yaml'), 'utf8');
  const data = parseSimple(text) as any;
  return {
    scopeRefs: data?.scopes ?? [],
    crossCutting: data?.cross_cutting ?? [],
  };
}

function readArchitecture(repoRoot: string, scopeId: string): Layer[] {
  const text = readFileSync(path.join(tenboDir(repoRoot), 'scopes', scopeId, 'architecture.yaml'), 'utf8');
  const data = parseSimple(text) as any;
  return data?.layers ?? [];
}

function readRoadmap(repoRoot: string, scopeId: string): Item[] {
  const text = readFileSync(path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap.yaml'), 'utf8');
  const data = parseSimple(text) as any;
  return data?.items ?? [];
}

function readNarratives(repoRoot: string, scopeId: string): Record<string, string> {
  const dir = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'layers');
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    const readme = path.join(full, 'README.md');
    if (existsSync(readme)) {
      out[`${scopeId}/${entry}`] = readFileSync(readme, 'utf8');
    }
  }
  return out;
}

export interface LayerDocEntry {
  filename: string;
  title: string | null;
}

export function listLayerDocs(repoRoot: string, scopeId: string, layerId: string): LayerDocEntry[] {
  const layerDir = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'layers', layerId);
  if (!existsSync(layerDir) || !statSync(layerDir).isDirectory()) return [];
  const out: LayerDocEntry[] = [];
  for (const entry of readdirSync(layerDir)) {
    if (!entry.endsWith('.md')) continue;
    if (entry === 'README.md') continue;
    const full = path.join(layerDir, entry);
    if (!statSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8');
    const m = text.match(/^#\s+(.+)$/m);
    out.push({ filename: entry, title: m ? m[1].trim() : null });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

function tryStat(p: string): Stats | null {
  try { return statSync(p); } catch { return null; }
}

function readLayerDocs(repoRoot: string, scopeId: string): Record<string, LayerDocs> {
  const dir = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'layers');
  if (!existsSync(dir)) return {};
  const out: Record<string, LayerDocs> = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const entryStat = tryStat(full);
    if (!entryStat?.isDirectory()) continue;
    const intentPath = path.join(full, 'intent.md');
    const intentStat = tryStat(intentPath);
    const codeMapStat = tryStat(path.join(full, 'code-map.md'));
    let intentEmpty = false;
    if (intentStat) {
      try {
        const stripped = readFileSync(intentPath, 'utf8')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/^#.*$/gm, '')
          .trim();
        intentEmpty = stripped.length === 0;
      } catch {
        // Read failure (race, permission, broken symlink): treat as non-empty;
        // higher layers will surface a different error if the file is unusable.
        intentEmpty = false;
      }
    }
    out[`${scopeId}/${entry}`] = {
      hasIntent: !!intentStat,
      hasCodeMap: !!codeMapStat,
      intentMtime: intentStat?.mtimeMs ?? null,
      codeMapMtime: codeMapStat?.mtimeMs ?? null,
      intentEmpty,
    };
  }
  return out;
}

function readCrossCuttingRoadmap(repoRoot: string): Item[] {
  const file = path.join(tenboDir(repoRoot), 'roadmap.yaml');
  if (!existsSync(file)) return [];
  const data = parseSimple(readFileSync(file, 'utf8')) as any;
  return data?.items ?? [];
}

function readMetrics(repoRoot: string, scopeId: string): ScopeMetrics | undefined {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'metrics.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ScopeMetrics;
  } catch (err) {
    console.warn(`tenbo: failed to parse ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * List spec markdown files under `.tenbo/specs/` and `.tenbo/specs/archive/`.
 * Returns a Set of repo-relative paths (e.g. `.tenbo/specs/x-001-foo.md`).
 * Returns undefined if `.tenbo/specs/` does not exist.
 */
export function readSpecFiles(repoRoot: string): Set<string> | undefined {
  const specsDir = path.join(tenboDir(repoRoot), 'specs');
  if (!existsSync(specsDir)) return undefined;
  const out = new Set<string>();
  for (const entry of readdirSync(specsDir)) {
    if (entry.endsWith('.md')) out.add(`.tenbo/specs/${entry}`);
  }
  const archiveDir = path.join(specsDir, 'archive');
  if (existsSync(archiveDir) && statSync(archiveDir).isDirectory()) {
    for (const entry of readdirSync(archiveDir)) {
      if (entry.endsWith('.md')) out.add(`.tenbo/specs/archive/${entry}`);
    }
  }
  return out;
}

export function readState(repoRoot: string): TenboState {
  const ws = readWorkspace(repoRoot);
  const scopes: Scope[] = ws.scopeRefs.map(ref => ({
    id: ref.id,
    path: ref.path,
    description: ref.description,
    layers: readArchitecture(repoRoot, ref.id),
    items: readRoadmap(repoRoot, ref.id),
  }));
  const narratives = scopes.reduce<Record<string, string>>((acc, s) => {
    return Object.assign(acc, readNarratives(repoRoot, s.id));
  }, {});
  const layerDocs = scopes.reduce<Record<string, LayerDocs>>((acc, s) => {
    return Object.assign(acc, readLayerDocs(repoRoot, s.id));
  }, {});
  const crossCuttingRoadmap = readCrossCuttingRoadmap(repoRoot);
  const metrics: Record<string, ScopeMetrics> = {};
  for (const s of scopes) {
    const m = readMetrics(repoRoot, s.id);
    if (m) metrics[s.id] = m;
  }
  const workspaceContent = readWorkspaceContent(repoRoot);
  const state: TenboState = { scopes, crossCutting: ws.crossCutting, narratives, workspaceContent };
  state.layerDocs = layerDocs;
  state.crossCuttingRoadmap = crossCuttingRoadmap;
  if (Object.keys(metrics).length > 0) state.metrics = metrics;
  const specFiles = readSpecFiles(repoRoot);
  if (specFiles) state.specFiles = specFiles;
  return state;
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

export function patchItem(repoRoot: string, scopeId: string, itemId: string, patch: Partial<Item>): void {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap.yaml');
  const text = readFileSync(file, 'utf8');
  const doc = parseYaml(text);
  patchSeqItem(doc, 'items', itemId, patch as Record<string, unknown>);
  atomicWrite(file, stringifyYaml(doc));
}

export function reorderItems(repoRoot: string, scopeId: string, idsInOrder: string[]): void {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap.yaml');
  const text = readFileSync(file, 'utf8');
  const doc = parseYaml(text);
  reorderSeqItems(doc, 'items', idsInOrder);
  atomicWrite(file, stringifyYaml(doc));
}
