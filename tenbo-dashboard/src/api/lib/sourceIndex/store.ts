import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { generatedCachePath, readGeneratedCacheFile, writeGeneratedCacheFile } from '../tenboFs';
import type { IndexFreshness, SourceIndex, SourceIndexInputMap } from './types';

export const SOURCE_INDEX_SCHEMA_VERSION = 1;
const SOURCE_INDEX_CACHE_PARTS = ['source-index.json'];

const INPUT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.yaml', '.yml', '.json']);
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'out']);

export function sourceIndexPath(repoRoot: string): string {
  return generatedCachePath(repoRoot, ...SOURCE_INDEX_CACHE_PARTS);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hashFile(filePath: string): string {
  return sha256(readFileSync(filePath, 'utf8'));
}

function repoRelative(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function shouldTrack(rel: string): boolean {
  if (rel === '.tenbo/cache/source-index.json') return false;
  if (rel.startsWith('.tenbo/cache/')) return false;
  if (rel.startsWith('.tenbo/scopes/') && rel.endsWith('/architecture.yaml')) return true;
  if (rel === '.tenbo/workspace.yaml' || rel === '.tenbo/overview.md') return true;
  if (rel.includes('/layers/') && rel.endsWith('.md')) return true;
  return INPUT_EXTENSIONS.has(path.extname(rel));
}

function walkInputs(repoRoot: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir).sort()) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = repoRelative(repoRoot, full);
        if (shouldTrack(rel)) out.push(rel);
      }
    }
  }
  walk(repoRoot);
  return out.sort();
}

export function computeSourceIndexInputs(repoRoot: string, paths?: string[]): SourceIndexInputMap {
  const inputs: SourceIndexInputMap = {};
  for (const rel of paths ?? walkInputs(repoRoot)) {
    const full = path.join(repoRoot, rel);
    if (!existsSync(full)) continue;
    try {
      inputs[rel] = hashFile(full);
    } catch {
      // Ignore unreadable files. The builder can surface detailed warnings.
    }
  }
  return inputs;
}

export function readSourceIndex(repoRoot: string): SourceIndex | null {
  const raw = readGeneratedCacheFile(repoRoot, SOURCE_INDEX_CACHE_PARTS);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SourceIndex;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files) || !Array.isArray(parsed.layers)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeSourceIndex(repoRoot: string, index: SourceIndex): void {
  writeGeneratedCacheFile(repoRoot, SOURCE_INDEX_CACHE_PARTS, `${JSON.stringify(index, null, 2)}\n`);
}

export function checkSourceIndexFreshness(repoRoot: string, index: SourceIndex | null = readSourceIndex(repoRoot)): IndexFreshness {
  const artifactPath = sourceIndexPath(repoRoot);
  if (!existsSync(artifactPath)) {
    return {
      status: 'missing',
      path: artifactPath,
      message: 'source index is missing',
      current_inputs: computeSourceIndexInputs(repoRoot),
      changed_inputs: [],
    };
  }
  if (!index) {
    return {
      status: 'corrupt',
      path: artifactPath,
      message: 'source index is corrupt or unreadable',
      current_inputs: computeSourceIndexInputs(repoRoot),
      changed_inputs: [],
    };
  }
  const trackedPaths = Object.keys(index.inputs).sort();
  const current = computeSourceIndexInputs(repoRoot, trackedPaths);
  if (index.schema_version !== SOURCE_INDEX_SCHEMA_VERSION) {
    return {
      status: 'incompatible',
      path: artifactPath,
      message: `source index schema ${index.schema_version} is not supported`,
      current_inputs: current,
      changed_inputs: [],
    };
  }
  const changed = trackedPaths.filter((rel) => current[rel] !== index.inputs[rel]);
  return {
    status: changed.length > 0 ? 'stale' : 'fresh',
    path: artifactPath,
    message: changed.length > 0 ? `source index is stale (${changed.length} changed input${changed.length === 1 ? '' : 's'})` : 'source index is fresh',
    current_inputs: current,
    changed_inputs: changed,
  };
}
