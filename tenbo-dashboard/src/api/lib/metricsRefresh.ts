import path from 'node:path';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { parse as parseSimple } from 'yaml';
import { computeScopeMetrics } from './metrics.js';
import { collectAll } from './health/collectAll.js';
import { loadHealthConfig } from './health/config.js';
import type { LayerDocs, Scope, ScopeMetrics, Item, Layer } from '../../types.js';

const TRACKED_FILES = ['architecture.yaml', 'roadmap.yaml'];
const TRACKED_LAYER_FILES = ['intent.md', 'code-map.md'];
const FS_MTIME_TOLERANCE_MS = 1000;

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

function latestMtimeUnder(scopeDir: string, repoRoot: string, scopePath: string): number {
  let latest = 0;
  for (const f of TRACKED_FILES) {
    latest = Math.max(latest, safeMtime(path.join(scopeDir, f)));
  }
  const layersDir = path.join(scopeDir, 'layers');
  let layerEntries: string[] = [];
  try { layerEntries = readdirSync(layersDir); } catch { layerEntries = []; }
  for (const layer of layerEntries) {
    const layerDir = path.join(layersDir, layer);
    let isDir = false;
    try { isDir = statSync(layerDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    for (const f of TRACKED_LAYER_FILES) {
      latest = Math.max(latest, safeMtime(path.join(layerDir, f)));
    }
  }
  // Health findings depend on the scope's source files and the health config.
  // Without these, edits to source code (or threshold tuning) would be served
  // from a stale metrics.json cache.
  latest = Math.max(latest, safeMtime(path.join(repoRoot, '.tenbo', 'health.config.yaml')));
  latest = Math.max(latest, latestMtimeInTree(path.resolve(repoRoot, scopePath)));
  return latest;
}

function latestMtimeInTree(root: string): number {
  let latest = 0;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return 0; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build') continue;
    const full = path.join(root, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      latest = Math.max(latest, latestMtimeInTree(full));
    } else {
      latest = Math.max(latest, st.mtimeMs);
    }
  }
  return latest;
}

function readScope(repoRoot: string, scopeId: string): Scope {
  const tenbo = path.join(repoRoot, '.tenbo');
  const wsText = readFileSync(path.join(tenbo, 'workspace.yaml'), 'utf8');
  const ws = parseSimple(wsText) as { scopes?: { id: string; path: string; description?: string }[] };
  const ref = ws.scopes?.find(s => s.id === scopeId);
  if (!ref) throw new Error(`scope not found in workspace.yaml: ${scopeId}`);
  const archText = readFileSync(path.join(tenbo, 'scopes', scopeId, 'architecture.yaml'), 'utf8');
  const arch = parseSimple(archText) as { layers?: Layer[] };
  const roadText = readFileSync(path.join(tenbo, 'scopes', scopeId, 'roadmap.yaml'), 'utf8');
  const road = parseSimple(roadText) as { items?: Item[] };
  return {
    id: ref.id,
    path: ref.path,
    description: ref.description ?? '',
    layers: arch.layers ?? [],
    items: road.items ?? [],
  };
}

function readLayerDocsForScope(repoRoot: string, scopeId: string): Record<string, LayerDocs> {
  const dir = path.join(repoRoot, '.tenbo', 'scopes', scopeId, 'layers');
  if (!existsSync(dir)) return {};
  const out: Record<string, LayerDocs> = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let entrySt;
    try { entrySt = statSync(full); } catch { continue; }
    if (!entrySt.isDirectory()) continue;
    const intentPath = path.join(full, 'intent.md');
    const codeMapPath = path.join(full, 'code-map.md');
    const intentExists = existsSync(intentPath);
    const codeMapExists = existsSync(codeMapPath);
    let intentEmpty = false;
    if (intentExists) {
      try {
        const stripped = readFileSync(intentPath, 'utf8')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/^#.*$/gm, '')
          .trim();
        intentEmpty = stripped.length === 0;
      } catch {
        intentEmpty = false;
      }
    }
    out[`${scopeId}/${entry}`] = {
      hasIntent: intentExists,
      hasCodeMap: codeMapExists,
      intentMtime: intentExists ? statSync(intentPath).mtimeMs : null,
      codeMapMtime: codeMapExists ? statSync(codeMapPath).mtimeMs : null,
      intentEmpty,
    };
  }
  return out;
}

export interface EnsureFreshOptions {
  force?: boolean;
}

export async function ensureFresh(repoRoot: string, scopeId: string, opts: EnsureFreshOptions = {}): Promise<ScopeMetrics> {
  const scopeDir = path.join(repoRoot, '.tenbo', 'scopes', scopeId);
  const metricsPath = path.join(scopeDir, 'metrics.json');
  const scope = readScope(repoRoot, scopeId);
  const latestSource = latestMtimeUnder(scopeDir, repoRoot, scope.path);
  const metricsMtime = safeMtime(metricsPath);

  // Tolerance absorbs filesystem mtime precision loss (some FSes round to seconds)
  // when comparing the metrics.json mtime against the latest tracked source mtime.
  if (!opts.force && metricsMtime > 0 && metricsMtime + FS_MTIME_TOLERANCE_MS >= latestSource) {
    try {
      const raw = readFileSync(metricsPath, 'utf8');
      return JSON.parse(raw) as ScopeMetrics;
    } catch {
      // Fall through to recompute on parse error (truncated/corrupt cache).
    }
  }

  const layerDocs = readLayerDocsForScope(repoRoot, scopeId);
  const baseMetrics = computeScopeMetrics(repoRoot, scope, layerDocs);
  const healthConfig = loadHealthConfig(repoRoot);
  const findings = await collectAll(repoRoot, scope, healthConfig);
  const metrics: ScopeMetrics = { ...baseMetrics, findings };
  // Atomic write: rename is atomic on POSIX so partial writes can't corrupt the cache.
  const tmpPath = metricsPath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(metrics, null, 2));
  renameSync(tmpPath, metricsPath);
  return metrics;
}
