import type { Item, Scope } from '../../../types';
import type { Finding, Signal } from './types';
import type { HealthConfig } from './config';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveLayerFiles } from './layerFiles';
import { analyzeHotspotFiles } from './hotspotFiles';
import { analyzeAgingTodos } from './agingTodos';
import { analyzeDocDrift } from './docDrift';
import { analyzeTestCoverage } from './testCoverage';
import { analyzeArchCompliance } from './archCompliance';
import { buildImportGraph } from './importGraph';
import type { ImportGraph } from './importGraph';
import { analyzeDeadCode } from './deadCode';
import { analyzeCoupling } from './coupling';
import { analyzeRedundancy } from './redundancy';
import { analyzeAgingSuperseded } from './agingSuperseded';

interface AnalyzerArgs {
  repoRoot: string;
  scopeId: string;
  scopePath?: string;
  layerId: string;
  files: string[];
  config: HealthConfig;
  graph?: ImportGraph;
}
type AnalyzerFn = (args: AnalyzerArgs) => Finding[];

const ANALYZERS: Record<Signal, AnalyzerFn | null> = {
  'hotspot-files':            ({ repoRoot, layerId, files, config }) => analyzeHotspotFiles(repoRoot, layerId, files, config),
  'aging-todos':              ({ repoRoot, layerId, files, config }) => analyzeAgingTodos(repoRoot, layerId, files, config),
  'aging-superseded':         null, // scope-wide item analyzer, dispatched after the layer loop
  'doc-drift':                ({ repoRoot, scopeId, layerId, files, scopePath }) => analyzeDocDrift(repoRoot, scopeId, layerId, files, scopePath),
  'test-coverage':            ({ repoRoot, layerId, files }) => analyzeTestCoverage(repoRoot, layerId, files),
  'architecture-compliance':  ({ layerId, files }) => analyzeArchCompliance(layerId, files),
  'dead-code':                ({ repoRoot, layerId, files, graph }) => graph ? analyzeDeadCode(repoRoot, layerId, files, graph) : [],
  'coupling':                 null, // dispatched once per scope after the layer loop
  'redundancy':               null, // Phase 4
};

const SOURCE_EXT_RE = /\.tsx?$/;
const IGNORED_SOURCE_DIRS = new Set([
  '.git',
  '.tenbo',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out',
]);

function collectScopeSourceFiles(repoRoot: string, scopePath: string, seedFiles: string[]): string[] {
  const sourceFiles = new Set(seedFiles.filter(f => SOURCE_EXT_RE.test(f)));
  const root = path.resolve(repoRoot, scopePath || '.');
  if (!existsSync(root)) return Array.from(sourceFiles).sort();

  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries.sort()) {
      if (IGNORED_SOURCE_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXT_RE.test(entry) && !entry.endsWith('.d.ts')) {
        sourceFiles.add(path.relative(repoRoot, full).split(path.sep).join('/'));
      }
    }
  }
  walk(root);
  return Array.from(sourceFiles).sort();
}

function tsConfigForScope(repoRoot: string, scopePath: string): string | undefined {
  const scoped = path.join(repoRoot, scopePath || '.', 'tsconfig.json');
  if (existsSync(scoped)) return scoped;
  const root = path.join(repoRoot, 'tsconfig.json');
  return existsSync(root) ? root : undefined;
}

export async function collectAll(repoRoot: string, scope: Scope, config: HealthConfig, allItems?: Map<string, Item>): Promise<Finding[]> {
  const filesByLayer = resolveLayerFiles(repoRoot, scope);
  const allTsFiles = collectScopeSourceFiles(repoRoot, scope.path, Object.values(filesByLayer).flat());
  let graph: ImportGraph | undefined;
  try {
    graph = buildImportGraph(repoRoot, allTsFiles, { tsConfigFilePath: tsConfigForScope(repoRoot, scope.path) });
  } catch {
    // No tsconfig or build error — skip import-graph dependent analyzers
  }
  const out: Finding[] = [];
  for (const layer of scope.layers) {
    const opted = new Set<Signal>(config.ignore.layer_signals[layer.id] ?? []);
    const files = filesByLayer[layer.id] ?? [];
    for (const [signal, fn] of Object.entries(ANALYZERS) as [Signal, AnalyzerFn | null][]) {
      if (!fn) continue;
      if (opted.has(signal)) continue;
      try {
        out.push(...fn({ repoRoot, scopeId: scope.id, scopePath: scope.path, layerId: layer.id, files, config, graph }));
      } catch (e) {
        // Analyzer failures don't break the whole report. Log and continue.
        console.error(`[health] analyzer ${signal} failed for layer ${layer.id}:`, e);
      }
    }
  }
  // Coupling is a scope-wide analyzer — run once after per-layer loop
  if (graph) {
    try {
      const couplingFindings = analyzeCoupling(filesByLayer, graph)
        .filter(f => !(config.ignore.layer_signals[f.layer] ?? []).includes('coupling'));
      out.push(...couplingFindings);
    } catch (e) {
      console.error('[health] analyzer coupling failed:', e);
    }
  }
  // Redundancy is scope-wide and async (jscpd) — run after per-layer + coupling
  const redundancyFindings = await analyzeRedundancy(repoRoot, filesByLayer, config).catch(e => {
    console.error('[health] redundancy failed:', e);
    return [] as Finding[];
  });
  out.push(...redundancyFindings.filter(f => !(config.ignore.layer_signals[f.layer] ?? []).includes('redundancy')));

  // Aging-superseded is item-based (not file-based) — run once per scope
  try {
    const itemMap = allItems ?? new Map(scope.items.map(i => [i.id, i]));
    const agingFindings = analyzeAgingSuperseded(scope, itemMap);
    out.push(...agingFindings.filter(f => !(config.ignore.layer_signals[f.layer] ?? []).includes('aging-superseded')));
  } catch (e) {
    console.error('[health] aging-superseded failed:', e);
  }

  return out;
}
