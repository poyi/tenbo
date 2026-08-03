/**
 * journal.ts — append-only mutation event journal (td-030 / x-004
 * "Attribution and event journal").
 *
 * Every applied mutation (hub path AND direct-write fallback — see
 * `applyMutation` in mutations.ts, the single choke point both go through)
 * writes exactly one small JSON file under `.tenbo/journal/`, mirroring the
 * one-file-per-record, conflict-free pattern already used by
 * `.tenbo/.id-locks/`: many writers can create files in the same directory
 * concurrently with zero risk of two writers corrupting a shared file,
 * because no writer ever appends to or rewrites another writer's file.
 *
 * Filenames are `<ISO-timestamp>-<pid>-<counter>.json`. Uniqueness holds
 * because:
 *   - two different OS processes never share a pid at the same moment, so
 *     cross-process collisions are structurally impossible;
 *   - within one process, `counter` is a strictly increasing in-memory
 *     value, so two events emitted by the same process (even in the same
 *     millisecond, even concurrently via `Promise.all`) never collide.
 * The file is written with the `wx` flag (fail if it already exists) as a
 * defensive belt-and-suspenders check: a collision would indicate a bug in
 * the uniqueness scheme above, and failing loudly beats silently clobbering
 * an audit record.
 *
 * Like the hub lockfile (lockfile.ts), the journal directory is resolved
 * through the SHARED hub repo root (`resolveHubRepoRoot`), not the raw
 * `repoRoot` a caller passes in, so every worktree of one repository reads
 * and writes the same `.tenbo/journal/` regardless of which worktree the
 * caller happens to run from.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveHubRepoRoot } from './hubRepoRoot';

export interface JournalEvent {
  /** The mutation id shared by the hub-apply and fallback-apply attempts of one CLI invocation (idempotency key). */
  mutationId: string;
  /** Resolved agent identity (see identity.ts) — who made this mutation. */
  actor: string;
  /** ISO 8601 UTC timestamp of when the event was journaled. */
  timestamp: string;
  /** The roadmap item this mutation targeted. */
  itemId: string;
  /** The mutation operation, e.g. 'add-note', 'complete', 'set-status'. */
  operation: string;
  /** Hash of the typed request. Reusing a mutation id with a different hash is rejected. */
  requestHash?: string;
  /** Stored typed command result, used to make allocation/create/document commands replay-safe. */
  result?: unknown;
}

export type JournalEventInput = Omit<JournalEvent, 'timestamp'> & { timestamp?: string };

export interface AppendJournalOptions {
  /** Injectable for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable for tests. Defaults to `process.pid`. */
  pid?: number;
  /** Injectable for tests. Defaults to a module-level monotonic counter. */
  counter?: () => number;
}

export interface ReadJournalFilters {
  itemId?: string;
  mutationId?: string;
}

let processCounter = 0;
function nextCounter(): number {
  processCounter += 1;
  return processCounter;
}

// `resolveHubRepoRoot` shells out to `git rev-parse --git-common-dir` (see
// hubRepoRoot.ts) — cheap in isolation, but this module is on the hot path
// of every mutation (a journal read for the idempotency check, then a
// journal write), and a live hub applies many mutations over its lifetime
// for the SAME repoRoot. Memoize per input `repoRoot` string so a long-lived
// hub process pays the subprocess-spawn cost once instead of twice per
// mutation forever. Safe to cache: a process's git worktree topology for a
// given path does not change while that process is running.
const hubRootCache = new Map<string, string>();
function hubRoot(repoRoot: string): string {
  const cached = hubRootCache.get(repoRoot);
  if (cached !== undefined) return cached;
  const resolved = resolveHubRepoRoot(repoRoot) ?? repoRoot;
  hubRootCache.set(repoRoot, resolved);
  return resolved;
}

function journalDir(repoRoot: string): string {
  return path.join(hubRoot(repoRoot), '.tenbo', 'journal');
}

function safeFilenameFragment(timestamp: string): string {
  // ISO timestamps contain ':' and '.', neither of which is safe/pretty in a
  // filename on all platforms — collapse them to '-' while keeping the
  // string sortable (lexicographic order still matches chronological order).
  return timestamp.replace(/[:.]/g, '-');
}

/**
 * Append one event to the journal as a new, uniquely-named file. Never
 * mutates or appends to an existing file — see the module doc comment for
 * why that makes this conflict-free under concurrent direct writers.
 */
export function appendJournalEvent(repoRoot: string, event: JournalEventInput, opts: AppendJournalOptions = {}): JournalEvent {
  const now = opts.now ?? (() => new Date());
  const pid = opts.pid ?? process.pid;
  const counter = opts.counter ?? nextCounter;

  const full: JournalEvent = {
    mutationId: event.mutationId,
    actor: event.actor,
    itemId: event.itemId,
    operation: event.operation,
    timestamp: event.timestamp ?? now().toISOString(),
    ...(event.requestHash ? { requestHash: event.requestHash } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
  };

  const dir = journalDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const filename = `${safeFilenameFragment(full.timestamp)}-${pid}-${counter()}.json`;
  writeFileSync(path.join(dir, filename), `${JSON.stringify(full, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return full;
}

/**
 * Read all journal events, optionally filtered by item id and/or mutation
 * id, sorted oldest-first by timestamp (ties broken by filename, which is
 * itself timestamp-prefixed so this is a stable total order). Malformed or
 * unreadable event files are skipped rather than throwing — the journal is
 * an audit aid, not a integrity-critical transaction log.
 */
export function readJournal(repoRoot: string, filters: ReadJournalFilters = {}): JournalEvent[] {
  const dir = journalDir(repoRoot);

  let filenames: string[];
  try {
    if (!existsSync(dir)) return [];
    filenames = readdirSync(dir);
  } catch (err) {
    // A directory-level failure (unreadable permissions, or the path was
    // replaced by a non-directory) must never abort a mutation — the
    // idempotency check (`hasJournaledMutation`) runs BEFORE the roadmap
    // write, so letting this throw would block every mutation on a broken
    // journal directory. Fail open: treat it the same as an empty journal.
    // Per-file failures below get the same treatment for the same reason.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`warning: unable to read journal directory ${dir}, treating as empty — ${message}\n`);
    return [];
  }

  const events: { file: string; event: JournalEvent }[] = [];
  for (const file of filenames) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Partial<JournalEvent>;
      if (
        typeof parsed.mutationId !== 'string' ||
        typeof parsed.actor !== 'string' ||
        typeof parsed.timestamp !== 'string' ||
        typeof parsed.itemId !== 'string' ||
        typeof parsed.operation !== 'string'
      ) {
        continue;
      }
      events.push({ file, event: parsed as JournalEvent });
    } catch {
      continue;
    }
  }

  events.sort((a, b) => a.event.timestamp.localeCompare(b.event.timestamp) || a.file.localeCompare(b.file));

  return events
    .map(({ event }) => event)
    .filter((event) => (filters.itemId ? event.itemId === filters.itemId : true))
    .filter((event) => (filters.mutationId ? event.mutationId === filters.mutationId : true));
}

/** True if `mutationId` has already been journaled — the idempotency check `applyMutation` runs before every mutation. */
export function hasJournaledMutation(repoRoot: string, mutationId: string): boolean {
  return readJournal(repoRoot, { mutationId }).length > 0;
}
