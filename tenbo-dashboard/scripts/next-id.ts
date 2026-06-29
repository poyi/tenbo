/**
 * next-id.ts — Atomic id allocator for tenbo roadmap items.
 *
 * Purpose:
 *   Read the relevant `roadmap.yaml` files for a given scope prefix, find the
 *   maximum three-digit suffix already in use, and return the next id, while
 *   atomically reserving it via a short-lived lock file. Two parallel callers
 *   must never get the same id.
 *
 * Usage:
 *   npx tenbo-dashboard next-id <prefix>
 *   # e.g. npx tenbo-dashboard next-id ed   →  ed-059
 *   # e.g. npx tenbo-dashboard next-id x    →  x-002
 *
 * When to use:
 *   Any tenbo skill behavior that needs to allocate a new roadmap-item id
 *   (Behaviors B2, B12, B13). Replaces ad-hoc grep+sort logic and removes the
 *   id-collision class of error.
 *
 * Lock-file convention:
 *   Locks live at `.tenbo/.id-locks/<prefix>-<NNN>.lock`. Each lock contains
 *   the allocating process's PID and a UTC timestamp. Locks older than 60s
 *   are considered stale and reclaimable. The directory is git-ignored.
 *
 * Output:
 *   On success, prints the allocated id (e.g. `ed-059`) to stdout with no
 *   decoration so callers can capture it via `$(...)`. Errors go to stderr
 *   and the process exits non-zero.
 */
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync, openSync, closeSync, writeSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { findRepoRoot } from '../src/api/lib/repoRoot';

export const STALE_LOCK_MS = 60_000;
const MAX_ATTEMPTS = 1000;

interface WorkspaceScope {
  id: string;
  prefix?: string;
  path?: string;
}

/** Find which roadmap.yaml files contain ids for this prefix. */
export function resolveRoadmapPaths(repoRoot: string, prefix: string): string[] {
  const tenbo = path.join(repoRoot, '.tenbo');
  if (prefix === 'x') {
    const p = path.join(tenbo, 'roadmap.yaml');
    return existsSync(p) ? [p] : [];
  }

  const wsPath = path.join(tenbo, 'workspace.yaml');
  if (!existsSync(wsPath)) return [];
  const ws = parseYaml(readFileSync(wsPath, 'utf8')) as { scopes?: WorkspaceScope[] } | null;
  const scopes = ws?.scopes ?? [];
  const match = scopes.find((s) => s.prefix === prefix);
  if (!match) return [];
  const p = path.join(tenbo, 'scopes', match.id, 'roadmap.yaml');
  return existsSync(p) ? [p] : [];
}

/** Collect numeric suffixes for `<prefix>-NNN` ids across the given roadmap files. */
export function collectExistingNumbers(roadmapPaths: string[], prefix: string): number[] {
  const re = new RegExp(`^${prefix}-(\\d{3})$`);
  const nums: number[] = [];
  for (const p of roadmapPaths) {
    const text = readFileSync(p, 'utf8');
    // Use a forgiving regex scan rather than full YAML parse — some roadmaps
    // contain unrelated YAML errors that block parsing but leave the `id:`
    // lines intact.
    const idLines = text.match(/^\s*-?\s*id:\s*[^\s#]+/gm) ?? [];
    for (const line of idLines) {
      const m = line.match(/id:\s*([^\s#]+)/);
      if (!m) continue;
      const id = m[1].replace(/['"]/g, '');
      const mm = id.match(re);
      if (mm) nums.push(Number(mm[1]));
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

/** Returns true if a usable lock for `id` exists; cleans stale locks as a side effect. */
function lockIsActive(repoRoot: string, id: string, now: number): boolean {
  const p = lockPath(repoRoot, id);
  if (!existsSync(p)) return false;
  try {
    const st = statSync(p);
    if (now - st.mtimeMs > STALE_LOCK_MS) {
      try { unlinkSync(p); } catch { /* race; treat as gone */ }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Attempt to atomically create a lock file. Returns true on success. */
function tryAcquireLock(repoRoot: string, id: string): boolean {
  const dir = lockDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = lockPath(repoRoot, id);
  try {
    // 'wx' = exclusive create. Two parallel processes cannot both succeed.
    const fd = openSync(p, 'wx');
    const payload = JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
    writeSync(fd, payload);
    closeSync(fd);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') return false;
    throw e;
  }
}

export interface AllocateOptions {
  repoRoot: string;
  prefix: string;
  /** For tests: clock injection. */
  now?: () => number;
}

export function allocateNextId(opts: AllocateOptions): string {
  const { repoRoot, prefix } = opts;
  const now = opts.now ?? Date.now;

  const paths = resolveRoadmapPaths(repoRoot, prefix);
  const existing = collectExistingNumbers(paths, prefix);
  const startFrom = existing.length ? Math.max(...existing) + 1 : 1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const n = startFrom + attempt;
    const id = `${prefix}-${String(n).padStart(3, '0')}`;
    // If a fresh lock already exists for this id, skip past it.
    if (lockIsActive(repoRoot, id, now())) continue;
    if (tryAcquireLock(repoRoot, id)) return id;
    // Lost the race — another caller just grabbed this id. Try the next.
  }
  throw new Error(`next-id: could not allocate after ${MAX_ATTEMPTS} attempts for prefix "${prefix}"`);
}

function isMain(): boolean {
  // Compare resolved path to argv[1]. Works under tsx.
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname);
    return invoked === here;
  } catch {
    return false;
  }
}

if (isMain()) {
  const prefix = process.argv[2];
  if (!prefix) {
    console.error('Usage: next-id <prefix>  (e.g. next-id ed)');
    process.exit(2);
  }
  try {
    const cwd = process.cwd();
    const repoRoot = findRepoRoot(cwd) ?? path.resolve(cwd, '..', '..');
    const id = allocateNextId({ repoRoot, prefix });
    process.stdout.write(id + '\n');
    process.exit(0);
  } catch (e) {
    console.error(`next-id: ${(e as Error).message}`);
    process.exit(1);
  }
}
