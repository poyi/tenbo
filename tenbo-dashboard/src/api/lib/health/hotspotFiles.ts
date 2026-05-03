import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { Finding, Severity } from './types';
import type { HealthConfig } from './config';

function lineCount(absPath: string): number {
  const content = readFileSync(absPath, 'utf8');
  if (content.length === 0) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

function severityFor(loc: number, t: HealthConfig['thresholds']['hotspot_loc']): Severity | null {
  if (loc >= t.critical) return 'critical';
  if (loc >= t.warning) return 'warning';
  if (loc >= t.info) return 'info';
  return null;
}

function commits30d(repoRoot: string, relPath: string): number {
  try {
    const out = execSync(`git log --since="30 days ago" --pretty=format:%H -- "${relPath}"`, {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === '' ? 0 : out.trim().split('\n').length;
  } catch {
    return 0;
  }
}

export function analyzeHotspotFiles(
  repoRoot: string,
  layerId: string,
  files: string[],         // repo-relative
  config: HealthConfig,
): Finding[] {
  const findings: Finding[] = [];
  const ignored = new Set(config.ignore.hotspot_files);
  for (const rel of files) {
    if (ignored.has(rel)) continue;
    const abs = path.resolve(repoRoot, rel);
    let loc: number;
    try { loc = lineCount(abs); } catch { continue; }
    const severity = severityFor(loc, config.thresholds.hotspot_loc);
    if (!severity) continue;
    const filename = path.basename(rel);
    findings.push({
      id: `${layerId}.hotspot-files.${filename.replace(/\W/g, '_')}`,
      signal: 'hotspot-files',
      severity,
      confidence: 'high',
      layer: layerId,
      target: rel,
      headline: `${filename} (${loc.toLocaleString()} LOC)`,
      suggestion: {
        summary: `Split ${filename} into smaller files`,
        rationale: `${loc.toLocaleString()} LOC exceeds ${severity} threshold of ${config.thresholds.hotspot_loc[severity].toLocaleString()}.`,
        action_kind: 'split-file',
      },
      details: {
        kind: 'hotspot-files',
        loc,
        top_functions: [],
        commits_30d: commits30d(repoRoot, rel),
        split_candidates: [],
      },
    });
  }
  return findings;
}
