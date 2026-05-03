import { execSync } from 'node:child_process';
import path from 'node:path';
import type { Finding } from './types';
import type { ImportGraph } from './importGraph';

const ENTRY_PATTERNS = [
  /\/main\.tsx?$/, /\/index\.tsx?$/, /\.test\.tsx?$/, /\.config\.[mc]?[jt]s$/, /vite\.config/,
];

function isLikelyEntry(file: string): boolean {
  return ENTRY_PATTERNS.some(re => re.test(file));
}

function lastImportedCommit(repoRoot: string, file: string): string | null {
  try {
    const out = execSync(`git log -1 --pretty=format:%H -- "${file}"`, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function gitAgeDays(repoRoot: string, file: string): number {
  try {
    const out = execSync(`git log -1 --pretty=format:%at -- "${file}"`, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ts = Number(out.trim()) * 1000;
    if (!ts) return 0;
    return Math.floor((Date.now() - ts) / (24 * 3600 * 1000));
  } catch {
    return 0;
  }
}

export function analyzeDeadCode(
  repoRoot: string,
  layerId: string,
  files: string[],
  graph: ImportGraph,
): Finding[] {
  const findings: Finding[] = [];
  for (const rel of files) {
    // Only analyze TypeScript/TSX source files
    if (!/\.tsx?$/.test(rel)) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
    if (graph.importedBy(rel).length > 0) continue;
    const filename = path.basename(rel);
    const isEntry = isLikelyEntry(rel);
    findings.push({
      id: `${layerId}.dead-code.${filename.replace(/\W/g, '_')}`,
      signal: 'dead-code',
      severity: isEntry ? 'info' : 'critical',
      confidence: isEntry ? 'low' : 'high',
      layer: layerId,
      target: rel,
      headline: `${filename} has no in-repo importers`,
      suggestion: {
        summary: isEntry ? `Confirm ${filename} is intentionally an entry point` : `Delete ${filename}`,
        rationale: isEntry
          ? 'Looks like an entry point (main, index, config, test). Verify before deleting.'
          : 'No file in the repo imports this. Likely safe to remove.',
        action_kind: 'delete-file',
      },
      details: {
        kind: 'dead-code',
        exports: [],
        last_imported_commit: lastImportedCommit(repoRoot, rel),
        git_age_days: gitAgeDays(repoRoot, rel),
      },
    });
  }
  return findings;
}
