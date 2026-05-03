// FALLBACK: jscpd v4's ESM bundle has a broken `colors/safe` import in Node 22
// (missing `.js` extension), so the programmatic `detectClones` API cannot be
// imported directly. Instead we shell out to the jscpd CLI (CommonJS entry
// point — no ESM problem), parse its JSON report from a temp output dir, and
// clean up after ourselves.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HealthConfig } from './config';
import type { Finding, Severity } from './types';

// jscpd's exports map blocks require.resolve('jscpd/package.json') and
// require.resolve('jscpd/bin/jscpd'). Instead, walk up from this file's
// directory to find the nearest node_modules/.bin/jscpd shell wrapper.
const _thisDir = path.dirname(fileURLToPath(import.meta.url));

function jscpdBin(): string {
  let dir = _thisDir;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'jscpd');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'jscpd'; // fallback: rely on PATH
}

interface JscpdFile {
  name: string;   // may be absolute or relative to cwd
  start: number;
  end: number;
  startLoc?: { line: number };
  endLoc?: { line: number };
}

interface JscpdClone {
  firstFile: JscpdFile;
  secondFile: JscpdFile;
  lines?: number;
}

function layerOf(
  filesByLayer: Record<string, string[]>,
  filePath: string,
  repoRoot: string,
): string | undefined {
  // jscpd returns paths relative to cwd (repoRoot) or absolute — normalize both.
  const rel = path.isAbsolute(filePath)
    ? path.relative(repoRoot, filePath)
    : filePath;
  for (const [layerId, files] of Object.entries(filesByLayer)) {
    if (files.includes(rel)) return layerId;
  }
  return undefined;
}

function severityFor(copyCount: number, sameLayer: boolean): Severity {
  if (copyCount >= 3) return 'critical';
  if (!sameLayer) return 'warning';
  return 'info';
}

function resolveFilePath(filePath: string, repoRoot: string): string {
  if (path.isAbsolute(filePath)) return path.relative(repoRoot, filePath);
  // jscpd may return paths relative to cwd where the command ran (repoRoot)
  return filePath;
}

export async function analyzeRedundancy(
  repoRoot: string,
  filesByLayer: Record<string, string[]>,
  config: HealthConfig,
): Promise<Finding[]> {
  const allFiles = Object.values(filesByLayer).flat().filter(f => /\.tsx?$/.test(f));
  if (allFiles.length === 0) return [];

  const absPaths = allFiles.map(f =>
    path.isAbsolute(f) ? f : path.join(repoRoot, f),
  );

  const outDir = mkdtempSync(path.join(tmpdir(), 'jscpd-'));
  try {
    try {
      // jscpd .bin wrapper is a shell script; execute via sh to be safe.
      execFileSync(
        jscpdBin(),
        [
          '--reporters', 'json',
          '--output', outDir,
          '--min-lines', String(config.thresholds.redundancy_min_lines),
          '--silent',
          ...absPaths,
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // jscpd exits with code 1 when duplications exceed the threshold.
      // The report file is still written — only bail below if it's missing.
    }

    let report: { duplicates?: JscpdClone[] };
    try {
      const raw = readFileSync(path.join(outDir, 'jscpd-report.json'), 'utf8');
      report = JSON.parse(raw) as { duplicates?: JscpdClone[] };
    } catch {
      // No report file — no supported files found or jscpd failed entirely.
      return [];
    }

    const clones = report.duplicates ?? [];
    const findings: Finding[] = [];

    for (const clone of clones) {
      const pathA = resolveFilePath(clone.firstFile.name, repoRoot);
      const pathB = resolveFilePath(clone.secondFile.name, repoRoot);

      const layerA = layerOf(filesByLayer, pathA, repoRoot);
      const layerB = layerOf(filesByLayer, pathB, repoRoot);
      const layer = layerA ?? layerB ?? 'unknown';

      const startA = clone.firstFile.startLoc?.line ?? clone.firstFile.start;
      const endA = clone.firstFile.endLoc?.line ?? clone.firstFile.end;
      const startB = clone.secondFile.startLoc?.line ?? clone.secondFile.start;
      const endB = clone.secondFile.endLoc?.line ?? clone.secondFile.end;
      const lineCount = clone.lines ?? (endA - startA + 1);

      const sameLayer = layerA !== undefined && layerA === layerB;
      const severity = severityFor(2, sameLayer);

      const idKey = `${pathA.replace(/\W/g, '_')}_L${startA}`;
      findings.push({
        id: `${layer}.redundancy.${idKey}`,
        signal: 'redundancy',
        severity,
        confidence: 'high',
        layer,
        target: pathA,
        headline: `${path.basename(pathA)} duplicates ${lineCount} lines into ${path.basename(pathB)}`,
        suggestion: {
          summary: `Extract the duplicated ${lineCount}-line block into a shared module`,
          rationale: `Identical code in ${path.basename(pathA)} (L${startA}-${endA}) and ${path.basename(pathB)} (L${startB}-${endB}) creates maintenance risk — one fix must land in both places.`,
          action_kind: 'extract-shared',
        },
        details: {
          kind: 'redundancy',
          copies: [
            { path: pathA, lines: [startA, endA] },
            { path: pathB, lines: [startB, endB] },
          ],
          similarity_pct: 100,
        },
      });
    }

    return findings;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
