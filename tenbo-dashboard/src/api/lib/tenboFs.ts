import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync, statSync, mkdirSync, type Stats } from 'node:fs';
import path from 'node:path';
import { parse as parseSimple, stringify as yamlStringify } from 'yaml';
import { parseYaml, stringifyYaml, patchSeqItem, reorderSeqItems } from './yamlOrdered';
import { getCached, invalidate as invalidateCache } from './parseCache';
import type { TenboState, Scope, Item, Layer, CrossCutting, LayerDocs, ScopeMetrics, WorkspaceContent, LayerContent, DecisionRecord } from '../../types';

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
  // Cached parse — re-reads only when workspace.yaml content changes.
  // See parseCache.ts for the content-hash + transient-failure semantics.
  const file = path.join(tenboDir(repoRoot), 'workspace.yaml');
  const data = getCached(file, 'workspace-yaml', (text) => parseSimple(text) as any);
  return {
    scopeRefs: data?.scopes ?? [],
    crossCutting: data?.cross_cutting ?? [],
  };
}

function readArchitecture(repoRoot: string, scopeId: string): Layer[] {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'architecture.yaml');
  const data = getCached(file, 'architecture-yaml', (text) => parseSimple(text) as any);
  return data?.layers ?? [];
}

function readRoadmap(repoRoot: string, scopeId: string): Item[] {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap.yaml');
  const data = getCached(file, 'roadmap-yaml', (text) => parseSimple(text) as any);
  return data?.items ?? [];
}

export function readRoadmapArchive(repoRoot: string, scopeId: string): Item[] {
  const file = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap-archive.yaml');
  if (!existsSync(file)) return [];
  const data = getCached(file, 'roadmap-archive-yaml', (text) => parseSimple(text) as any);
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

/**
 * Read project-level decision records from `.tenbo/decisions/*.md`.
 * Returns undefined if the directory does not exist (graceful no-op).
 * Frontmatter is parsed leniently — malformed entries are still returned
 * with whatever fields could be parsed; the validator surfaces issues.
 */
export function readDecisions(repoRoot: string): Record<string, DecisionRecord> | undefined {
  const dir = path.join(tenboDir(repoRoot), 'decisions');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return undefined;
  const out: Record<string, DecisionRecord> = {};
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(dir, entry);
    if (!statSync(full).isFile()) continue;
    const text = readFileSync(full, 'utf8');
    const slug = entry.replace(/\.md$/, '');
    const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    let frontmatter: Record<string, unknown> = {};
    let body = text;
    if (fmMatch) {
      try {
        frontmatter = (parseSimple(fmMatch[1]) as Record<string, unknown>) ?? {};
      } catch {
        frontmatter = {};
      }
      body = fmMatch[2] ?? '';
    }
    out[slug] = {
      path: `.tenbo/decisions/${entry}`,
      slug,
      frontmatter: frontmatter as DecisionRecord['frontmatter'],
      body,
    };
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
    archivedItems: readRoadmapArchive(repoRoot, ref.id),
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
  const decisions = readDecisions(repoRoot);
  if (decisions) state.decisions = decisions;
  return state;
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
  // Drop any cached parse for this path. The next read will re-parse from
  // disk; the file watcher's invalidate will cover external edits, this
  // covers our own writes (no race with the SSE event arriving "later").
  invalidateCache(filePath);
}

export function generatedCachePath(repoRoot: string, ...parts: string[]): string {
  return path.join(tenboDir(repoRoot), 'cache', ...parts);
}

export function writeGeneratedCacheFile(repoRoot: string, parts: string[], content: string): void {
  const file = generatedCachePath(repoRoot, ...parts);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const ignorePath = path.join(generatedCachePath(repoRoot), '.gitignore');
  if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n!.gitignore\n', 'utf8');
  atomicWrite(file, content);
}

export function readGeneratedCacheFile(repoRoot: string, parts: string[]): string | null {
  const file = generatedCachePath(repoRoot, ...parts);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8');
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

/**
 * Move items from roadmap.yaml to roadmap-archive.yaml for the given scope.
 * Creates the archive file if it doesn't exist. Uses atomic writes for both files.
 */
export function archiveItems(repoRoot: string, scopeId: string, itemIds: string[]): void {
  if (itemIds.length === 0) return;

  const roadmapFile = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap.yaml');
  const archiveFile = path.join(tenboDir(repoRoot), 'scopes', scopeId, 'roadmap-archive.yaml');

  // Read roadmap and find matching items
  const roadmapText = readFileSync(roadmapFile, 'utf8');
  const roadmapData = parseSimple(roadmapText) as any;
  const allItems: Item[] = roadmapData?.items ?? [];

  const idsToArchive = new Set(itemIds);
  const itemsToArchive = allItems.filter(i => idsToArchive.has(i.id));
  const remainingItems = allItems.filter(i => !idsToArchive.has(i.id));

  if (itemsToArchive.length === 0) return;

  // Read existing archive
  let archiveItems: Item[] = [];
  if (existsSync(archiveFile)) {
    const archiveData = parseSimple(readFileSync(archiveFile, 'utf8')) as any;
    archiveItems = archiveData?.items ?? [];
  }

  // Append archived items
  archiveItems.push(...itemsToArchive);

  // Write both files atomically
  atomicWrite(roadmapFile, yamlStringify({ items: remainingItems }, { lineWidth: 0, blockQuote: 'literal' }));
  atomicWrite(archiveFile, yamlStringify({ items: archiveItems }, { lineWidth: 0, blockQuote: 'literal' }));
}
