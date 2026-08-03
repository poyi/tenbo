import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

export const STALE_LOCK_MS = 60_000;
const MAX_ATTEMPTS = 1000;

interface WorkspaceScope {
  id: string;
  prefix?: string;
}

function containsPrefix(filePath: string, prefix: string): boolean {
  if (!existsSync(filePath)) return false;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-?\\s*id:\\s*["']?${escaped}-\\d+`, 'm').test(readFileSync(filePath, 'utf8'));
}

/** Active and archived roadmaps that may contain ids for a prefix. */
export function resolveRoadmapPaths(repoRoot: string, prefix: string): string[] {
  const tenbo = path.join(repoRoot, '.tenbo');
  if (prefix === 'x') {
    return ['roadmap.yaml', 'roadmap-archive.yaml']
      .map((name) => path.join(tenbo, name))
      .filter(existsSync);
  }

  const wsPath = path.join(tenbo, 'workspace.yaml');
  if (!existsSync(wsPath)) return [];
  const ws = parseYaml(readFileSync(wsPath, 'utf8')) as { scopes?: WorkspaceScope[] } | null;
  const scopes = ws?.scopes ?? [];
  const explicit = scopes.filter((scope) => scope.prefix === prefix);
  const candidates = (explicit.length > 0 ? explicit : scopes)
    .flatMap((scope) => [
      path.join(tenbo, 'scopes', scope.id, 'roadmap.yaml'),
      path.join(tenbo, 'scopes', scope.id, 'roadmap-archive.yaml'),
    ])
    .filter(existsSync);
  if (explicit.length > 0) return candidates;
  return candidates.filter((filePath) => containsPrefix(filePath, prefix));
}

/** Collect numeric suffixes for `<prefix>-NNN` ids without requiring valid unrelated YAML. */
export function collectExistingNumbers(roadmapPaths: string[], prefix: string): number[] {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idPattern = new RegExp(`^${escaped}-(\\d+)$`);
  const nums: number[] = [];
  for (const filePath of roadmapPaths) {
    const idLines = readFileSync(filePath, 'utf8').match(/^\s*-?\s*id:\s*[^\s#]+/gm) ?? [];
    for (const line of idLines) {
      const raw = line.match(/id:\s*([^\s#]+)/)?.[1]?.replace(/["']/g, '');
      const match = raw?.match(idPattern);
      if (match) nums.push(Number(match[1]));
    }
  }
  return nums;
}

function lockDir(repoRoot: string): string {
  return path.join(repoRoot, '.tenbo', '.id-locks');
}

function lockPath(repoRoot: string, id: string): string {
  return path.join(lockDir(repoRoot), `${id}.lock`);
}

function lockIsActive(repoRoot: string, id: string, now: number): boolean {
  const filePath = lockPath(repoRoot, id);
  if (!existsSync(filePath)) return false;
  try {
    if (now - statSync(filePath).mtimeMs > STALE_LOCK_MS) {
      try { unlinkSync(filePath); } catch { /* another allocator won cleanup */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock(repoRoot: string, id: string): boolean {
  mkdirSync(lockDir(repoRoot), { recursive: true });
  try {
    const fd = openSync(lockPath(repoRoot, id), 'wx');
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export interface AllocateOptions {
  repoRoot: string;
  prefix: string;
  now?: () => number;
}

export function allocateNextId({ repoRoot, prefix, now = Date.now }: AllocateOptions): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(prefix)) throw new Error(`invalid item prefix: ${prefix}`);
  const existing = collectExistingNumbers(resolveRoadmapPaths(repoRoot, prefix), prefix);
  const start = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  for (let offset = 0; offset < MAX_ATTEMPTS; offset += 1) {
    const id = `${prefix}-${String(start + offset).padStart(3, '0')}`;
    if (lockIsActive(repoRoot, id, now())) continue;
    if (tryAcquireLock(repoRoot, id)) return id;
  }
  throw new Error(`next-id: could not allocate after ${MAX_ATTEMPTS} attempts for prefix "${prefix}"`);
}
