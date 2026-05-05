/**
 * parseCache.ts — content-hash-keyed memoized file parser.
 *
 * Reads a file, hashes its bytes, and returns the parsed result. Subsequent
 * calls for the same path with the same content return the cached parsed
 * value without re-reading or re-parsing. When the content changes (any
 * write through tenboFs, any external editor save), the next call detects
 * the new hash, re-parses, and caches the new value.
 *
 * Why content hash, not just mtime: HFS+ has 1-second mtime resolution, so
 * two writes within the same second look identical to mtime. Hashing the
 * bytes is unambiguous.
 *
 * Partial-write race handling: a read that catches a YAML/JSON file
 * mid-write may produce a parse error. The cache retains the previous good
 * value on transient parse failure (the next read will succeed). Persistent
 * failures bubble up to the caller on the SECOND attempt; the cache does
 * not silently mask broken files indefinitely.
 *
 * The file watcher (`watch.ts`) also calls `invalidate(absPath)` on file
 * change events so cache freshness doesn't depend on read frequency.
 *
 * Used by tenboFs.ts for the YAML reads that feed `readState` — by far the
 * hottest read path. Other helpers (markdown narratives, layer content)
 * could be added if perf measurement justifies it.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

interface CacheEntry<T> {
  hash: string;
  parsed: T;
  /** mtime at the time of cache fill — used as a cheap pre-check to skip the hash. */
  mtimeMs: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function safeMtime(absPath: string): number {
  try { return statSync(absPath).mtimeMs; } catch { return -1; }
}

function hashBytes(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Read+parse `absPath` with caching. `parser` is called only when the file's
 * content has changed since the last successful parse.
 *
 * `signature` is a short string identifying the parser variant — different
 * parsers (raw text vs YAML vs JSON) for the same path get separate cache
 * slots so callers can use the cache for both shapes without collision.
 */
export function getCached<T>(absPath: string, signature: string, parser: (text: string) => T): T {
  const key = `${signature}::${absPath}`;
  const mtime = safeMtime(absPath);

  const existing = cache.get(key) as CacheEntry<T> | undefined;
  // mtime fast-path: if the file's mtime hasn't moved AND we have a cached
  // entry, we can skip re-reading. This is the common case during a single
  // request that touches the same file twice.
  if (existing && existing.mtimeMs === mtime && mtime !== -1) {
    return existing.parsed;
  }

  // mtime changed (or no cache entry). Read + hash + maybe re-parse.
  const buf = readFileSync(absPath);
  const hash = hashBytes(buf);

  if (existing && existing.hash === hash) {
    // Content actually unchanged (mtime moved without content change — common
    // when an editor "touches" a file or after `touch -m`). Refresh the
    // mtime in the entry so the fast-path catches the next read.
    existing.mtimeMs = mtime;
    return existing.parsed;
  }

  // Re-parse. On parse error, retain previous good value (transient
  // partial-write race). The caller can re-attempt; if it fails twice the
  // exception propagates so we don't mask persistent corruption.
  try {
    const parsed = parser(buf.toString('utf8'));
    cache.set(key, { hash, parsed, mtimeMs: mtime });
    return parsed;
  } catch (err) {
    if (existing) return existing.parsed; // serve stale on transient failure
    throw err;
  }
}

/** Drop a cached entry. Called by the file watcher on change events. */
export function invalidate(absPath: string): void {
  for (const k of cache.keys()) {
    if (k.endsWith(`::${absPath}`)) cache.delete(k);
  }
}

/** For tests — clear everything. */
export function clearCache(): void {
  cache.clear();
}
