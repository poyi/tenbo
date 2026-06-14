import path from 'node:path';
import type { Finding } from './types';
import type { ImportGraph } from './importGraph';

const ENTRY_PATTERNS = [
  /\/main\.tsx?$/,
  /\/App\.tsx?$/,
  /\/AppRoutes\.tsx?$/,
  /\/index\.tsx?$/,
  /\/routes?\//,
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /\.stories\.tsx?$/,
  /\.config\.[mc]?[jt]s$/,
  /vite\.config/,
  /generated/i,
];

function isLikelyEntry(file: string): boolean {
  return ENTRY_PATTERNS.some(re => re.test(file));
}

export function analyzeDeadCode(
  _repoRoot: string,
  layerId: string,
  files: string[],
  graph: ImportGraph,
): Finding[] {
  const findings: Finding[] = [];
  const candidates = files.filter(rel => {
    if (!/\.tsx?$/.test(rel)) return false;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) return false;
    return graph.importedBy(rel).length === 0;
  });
  for (const rel of candidates) {
    const importers = graph.importedBy(rel);
    const filename = path.basename(rel);
    const isEntry = isLikelyEntry(rel);
    findings.push({
      id: `${layerId}.dead-code.${filename.replace(/\W/g, '_')}`,
      signal: 'dead-code',
      severity: isEntry ? 'info' : 'critical',
      confidence: isEntry ? 'low' : 'high',
      layer: layerId,
      target: rel,
      headline: `${filename} has no repo-wide static importers`,
      suggestion: {
        summary: isEntry ? `Review ${filename} as a possible entry point` : `Review ${filename}`,
        rationale: isEntry
          ? 'Looks like an entry point, route, config, story, test helper, or generated adapter. Verify its role before making changes.'
          : 'No repo-wide static import or barrel re-export was found. Review dynamic references and runtime entry points before removing it.',
        action_kind: 'review-file',
      },
      details: {
        kind: 'dead-code',
        exports: [],
        last_imported_commit: null,
        git_age_days: 0,
        repo_static_importers: importers,
        static_import_evidence: 'No repo-wide static import or barrel re-export found in the scope import graph.',
      },
    });
  }
  return findings;
}
