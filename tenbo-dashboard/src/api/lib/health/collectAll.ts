import type { Scope } from '../../../types';
import type { Finding, Signal } from './types';
import type { HealthConfig } from './config';
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

interface AnalyzerArgs {
  repoRoot: string;
  scopeId: string;
  layerId: string;
  files: string[];
  config: HealthConfig;
  graph?: ImportGraph;
}
type AnalyzerFn = (args: AnalyzerArgs) => Finding[];

const ANALYZERS: Record<Signal, AnalyzerFn | null> = {
  'hotspot-files':            ({ repoRoot, layerId, files, config }) => analyzeHotspotFiles(repoRoot, layerId, files, config),
  'aging-todos':              ({ repoRoot, layerId, files, config }) => analyzeAgingTodos(repoRoot, layerId, files, config),
  'doc-drift':                ({ repoRoot, scopeId, layerId, files }) => analyzeDocDrift(repoRoot, scopeId, layerId, files),
  'test-coverage':            ({ repoRoot, layerId, files }) => analyzeTestCoverage(repoRoot, layerId, files),
  'architecture-compliance':  ({ layerId, files }) => analyzeArchCompliance(layerId, files),
  'dead-code':                ({ repoRoot, layerId, files, graph }) => graph ? analyzeDeadCode(repoRoot, layerId, files, graph) : [],
  'coupling':                 null, // dispatched once per scope after the layer loop
  'redundancy':               null, // Phase 4
};

export async function collectAll(repoRoot: string, scope: Scope, config: HealthConfig): Promise<Finding[]> {
  const filesByLayer = resolveLayerFiles(repoRoot, scope);
  const allTsFiles = Object.values(filesByLayer).flat().filter(f => /\.tsx?$/.test(f));
  let graph: ImportGraph | undefined;
  try {
    graph = buildImportGraph(repoRoot, allTsFiles);
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
        out.push(...fn({ repoRoot, scopeId: scope.id, layerId: layer.id, files, config, graph }));
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
  return out;
}
