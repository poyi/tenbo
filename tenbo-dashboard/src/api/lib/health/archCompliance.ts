import path from 'node:path';
import type { Finding } from './types';

const CONVENTIONAL_FOLDERS = ['application', 'domain', 'infrastructure', 'services', 'ui', 'components', 'hooks', '__tests__'];

/**
 * Editor uses DDD-ish layout under each domain. We expect each file to live
 * in one of CONVENTIONAL_FOLDERS. Files at the domain root, or in folders not
 * in the list, get flagged.
 */
export function analyzeArchCompliance(
  layerId: string,
  files: string[],
): Finding[] {
  const findings: Finding[] = [];
  for (const rel of files) {
    const m = /\/domains\/[^/]+\/([^/]+)\//.exec(rel);
    if (m) {
      if (CONVENTIONAL_FOLDERS.includes(m[1])) continue;
      findings.push(makeFinding(layerId, rel, m[1], 'unconventional-subfolder'));
      continue;
    }
    const rootM = /\/domains\/[^/]+\/[^/]+$/.exec(rel);
    if (rootM) {
      findings.push(makeFinding(layerId, rel, '(root)', 'file-at-domain-root'));
    }
  }
  return findings;
}

function makeFinding(layerId: string, rel: string, actual: string, rule: string): Finding {
  const filename = path.basename(rel);
  return {
    id: `${layerId}.architecture-compliance.${filename.replace(/\W/g, '_')}`,
    signal: 'architecture-compliance',
    severity: 'warning',
    confidence: 'medium',
    layer: layerId,
    target: rel,
    headline: `${filename} is in a non-standard location ('${actual}')`,
    suggestion: {
      summary: `Move ${filename} to one of: application/, domain/, infrastructure/, services/, ui/`,
      rationale: 'Editor domains follow a conventional folder layout. Files outside it are harder to locate during navigation and code review.',
      action_kind: 'move-file',
    },
    details: {
      kind: 'architecture-compliance',
      expected_path_pattern: 'apps/editor/src/domains/<domain>/{application,domain,infrastructure,services,ui}/...',
      actual_path: rel,
      rule,
    },
  };
}
