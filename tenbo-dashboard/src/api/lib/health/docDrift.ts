import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from './types';

/**
 * Return file-like tokens from inline-code spans in a markdown document.
 * We require a `/` and a `.ext` to avoid matching prose words.
 */
export function extractFileRefs(md: string): string[] {
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const candidate = m[1].trim();
    if (/^[\w./@-]+\.[a-zA-Z]{1,5}$/.test(candidate) && candidate.includes('/')) out.push(candidate);
  }
  return out;
}

export function analyzeDocDrift(
  repoRoot: string,
  scopeId: string,
  layerId: string,
  layerFiles: string[],
  scopePath?: string,
): Finding[] {
  const docPath = path.join(repoRoot, '.tenbo/scopes', scopeId, 'layers', layerId, 'code-map.md');
  if (!existsSync(docPath)) return [];
  const md = readFileSync(docPath, 'utf8');
  const docMtime = statSync(docPath).mtimeMs;
  const refs = extractFileRefs(md);
  const refSet = new Set(refs);
  const findings: Finding[] = [];

  // 1. missing-ref: file in code-map.md doesn't exist on disk
  const broken: string[] = [];
  for (const ref of refs) {
    const existsAtRoot = existsSync(path.join(repoRoot, ref));
    const existsAtScope = scopePath ? existsSync(path.join(repoRoot, scopePath, ref)) : false;
    if (!existsAtRoot && !existsAtScope) broken.push(ref);
  }
  if (broken.length > 0) {
    const severity = broken.length >= 3 ? 'critical' : 'warning';
    findings.push({
      id: `${layerId}.doc-drift.missing-ref`,
      signal: 'doc-drift',
      severity,
      confidence: 'high',
      layer: layerId,
      target: path.relative(repoRoot, docPath).split(path.sep).join('/'),
      headline: `code-map.md references ${broken.length} non-existent file${broken.length === 1 ? '' : 's'}`,
      suggestion: {
        summary: 'Update code-map.md to remove or correct broken references',
        rationale: `${broken.length} reference${broken.length === 1 ? '' : 's'} point to files that no longer exist.`,
        action_kind: 'update-doc',
      },
      details: {
        kind: 'doc-drift',
        drift_type: 'missing-ref',
        doc_path: path.relative(repoRoot, docPath).split(path.sep).join('/'),
        doc_mtime_iso: new Date(docMtime).toISOString(),
        code_mtime_iso: null,
        affected_files: broken,
      },
    });
  }

  // 2. unreferenced-file: layer file not mentioned anywhere in code-map.md
  const orphan: string[] = [];
  for (const f of layerFiles) {
    if (refSet.has(f)) continue;
    const base = path.basename(f);
    if (md.includes(base)) continue;
    orphan.push(f);
  }
  if (orphan.length > 0) {
    findings.push({
      id: `${layerId}.doc-drift.unreferenced-file`,
      signal: 'doc-drift',
      severity: 'info',
      confidence: 'medium',
      layer: layerId,
      target: path.relative(repoRoot, docPath).split(path.sep).join('/'),
      headline: `${orphan.length} file${orphan.length === 1 ? '' : 's'} in this layer not mentioned in code-map.md`,
      suggestion: {
        summary: 'Add new files to code-map.md or confirm they belong in this layer',
        rationale: `These files exist in the layer's source paths but are not referenced anywhere in code-map.md.`,
        action_kind: 'update-doc',
      },
      details: {
        kind: 'doc-drift',
        drift_type: 'unreferenced-file',
        doc_path: path.relative(repoRoot, docPath).split(path.sep).join('/'),
        doc_mtime_iso: new Date(docMtime).toISOString(),
        code_mtime_iso: null,
        affected_files: orphan,
      },
    });
  }

  return findings;
}
