import type { Item, Scope } from '../../../types';
import type { Finding, Signal } from './types';
import type { HealthConfig } from './config';
import { resolveLayerFiles } from './layerFiles';
import { analyzeHotspotFiles } from './hotspotFiles';
import { analyzeAgingTodos } from './agingTodos';
import { analyzeDocDrift } from './docDrift';
import { analyzeTestCoverage } from './testCoverage';
import { analyzeArchCompliance } from './archCompliance';
import { graphFromSourceIndex } from './structuralGraph';
import type { ImportGraph } from './importGraph';
import { analyzeDeadCode } from './deadCode';
import { analyzeCoupling } from './coupling';
import { analyzeRedundancy } from './redundancy';
import { analyzeAgingSuperseded } from './agingSuperseded';
import { checkSourceIndexFreshness, readSourceIndex } from '../sourceIndex/store';
import type { GraphEvidence } from './types';

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

export async function collectAll(repoRoot: string, scope: Scope, config: HealthConfig, allItems?: Map<string, Item>): Promise<Finding[]> {
  const filesByLayer = resolveLayerFiles(repoRoot, scope);
  let graph: ImportGraph | undefined;
  let graphEvidence: GraphEvidence | undefined;
  const sourceIndex = readSourceIndex(repoRoot);
  const indexFreshness = checkSourceIndexFreshness(repoRoot, sourceIndex);
  if (indexFreshness.status === 'fresh' && sourceIndex) {
    graph = graphFromSourceIndex(sourceIndex, scope.id);
    graphEvidence = { mode: 'fresh-index', index_status: indexFreshness.status };
  }
  const out: Finding[] = [];
  for (const layer of scope.layers) {
    const opted = new Set<Signal>(config.ignore.layer_signals[layer.id] ?? []);
    const files = filesByLayer[layer.id] ?? [];
    for (const [signal, fn] of Object.entries(ANALYZERS) as [Signal, AnalyzerFn | null][]) {
      if (!fn) continue;
      if (opted.has(signal)) continue;
      try {
        const findings = fn({ repoRoot, scopeId: scope.id, scopePath: scope.path, layerId: layer.id, files, config, graph });
        out.push(...decorateGraphEvidence(findings, graphEvidence));
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
      out.push(...decorateGraphEvidence(couplingFindings, graphEvidence));
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

function decorateGraphEvidence(findings: Finding[], evidence: GraphEvidence | undefined): Finding[] {
  if (!evidence) return findings;
  return findings.map((finding) => {
    if (finding.signal !== 'dead-code' && finding.signal !== 'coupling') return finding;
    return {
      ...finding,
      details: {
        ...finding.details,
        graph_evidence: evidence,
      },
    } as Finding;
  });
}
