import path from 'node:path';
import type { Finding, Severity } from './types';
import type { ImportGraph } from './importGraph';

function isPublicApiPath(file: string): boolean {
  const base = path.basename(file);
  return base === 'index.ts' || base === 'index.tsx';
}

function severityFor(count: number): Severity {
  if (count >= 5) return 'critical';
  if (count >= 2) return 'warning';
  return 'info';
}

export function analyzeCoupling(
  filesByLayer: Record<string, string[]>,
  graph: ImportGraph,
): Finding[] {
  const layerOf = new Map<string, string>();
  for (const [layerId, files] of Object.entries(filesByLayer)) {
    for (const f of files) layerOf.set(f, layerId);
  }

  type Reach = { source: string; targetLayer: string; targetFile: string; sourceFiles: string[] };
  const reaches = new Map<string, Reach>();

  for (const [sourceFile, sourceLayer] of layerOf.entries()) {
    for (const targetFile of graph.importsFrom(sourceFile)) {
      const targetLayer = layerOf.get(targetFile);
      if (!targetLayer || targetLayer === sourceLayer) continue;
      if (isPublicApiPath(targetFile)) continue;
      const key = `${sourceLayer}->${targetFile}`;
      const cur = reaches.get(key) ?? { source: sourceLayer, targetLayer, targetFile, sourceFiles: [] };
      cur.sourceFiles.push(sourceFile);
      reaches.set(key, cur);
    }
  }

  const findings: Finding[] = [];
  for (const r of reaches.values()) {
    const severity = severityFor(r.sourceFiles.length);
    findings.push({
      id: `${r.source}.coupling.${r.targetFile.replace(/\W/g, '_')}`,
      signal: 'coupling',
      severity,
      confidence: 'high',
      layer: r.source,
      target: r.targetFile,
      headline: `${r.sourceFiles.length} import${r.sourceFiles.length === 1 ? '' : 's'} reach into ${r.targetLayer}/${path.basename(r.targetFile)}`,
      suggestion: {
        summary: `Extract a shared module or expose ${path.basename(r.targetFile)} via ${r.targetLayer}/index.ts`,
        rationale: `Layer ${r.source} reaches into layer ${r.targetLayer}'s internals (${r.targetFile}). Reaching past the public API tightens coupling.`,
        action_kind: 'extract-shared',
      },
      details: {
        kind: 'coupling',
        source_file: r.sourceFiles[0],
        target_file: r.targetFile,
        source_layer: r.source,
        target_layer: r.targetLayer,
        importer_count: r.sourceFiles.length,
        import_lines: [],
        crosses_public_api: false,
      },
    });
  }
  return findings;
}
