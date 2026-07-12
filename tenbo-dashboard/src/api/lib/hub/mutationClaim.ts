/**
 * mutationClaim.ts — cross-process, per-mutationId atomic claim (td-034).
 *
 * td-030 closed the SAME-PROCESS half of the idempotency story:
 * `applyMutation` (mutations.ts) checks `hasJournaledMutation` before
 * dispatching, so a retry that sees an already-journaled mutationId is a
 * no-op. That is sufficient once the journal entry is durably visible.
 *
 * The residual race is the WINDOW before it's visible: the hub can apply a
 * mutation and append its journal entry, but if the HTTP response back to
 * the CLI is lost (or the CLI's request times out first), the CLI falls
 * back to a direct `applyMutation` call with the SAME mutationId — and if
 * that fallback's `hasJournaledMutation` check runs before the hub's
 * journal write is visible to it, the guard says "not journaled" and the
 * mutation is dispatched a second time. `enqueueMutation` (mutationQueue.ts)
 * only serializes callers WITHIN the hub process — it cannot serialize the
 * hub process against a separate CLI process running the fallback.
 *
 * The fix is a filesystem-level exclusive claim keyed by mutationId,
 * checked from INSIDE `applyMutation` (so both the hub path and the
 * fallback path go through it, exactly like the journal check):
 *
 *   1. `hasJournaledMutation` is still the fast path (mutations.ts checks it
 *      before ever calling into this module) — unchanged.
 *   2. Atomically CREATE `.tenbo/journal/.claims/<mutationId>.claim` with
 *      `writeFileSync(..., { flag: 'wx' })`. Exclusive create is atomic
 *      across processes on a local filesystem — exactly the pattern
 *      `.tenbo/.id-locks/` already uses for id allocation (next-id.ts).
 *        - Created it -> we own this mutationId. Caller proceeds to
 *          dispatch + journal. The claim file is left in place afterwards
 *          (a deliberate choice, not an oversight — see "why keep the
 *          claim" below).
 *        - EEXIST -> someone else (this process on an earlier attempt, the
 *          hub, or a concurrent CLI fallback) already claimed this exact
 *          mutationId. Do NOT apply. Poll `hasJournaledMutation` briefly
 *          (bounded); if it appears, the other actor finished — return a
 *          "no-op, it's already applied" outcome. If the wait elapses with
 *          no journal entry, check whether the claimant is dead or its
 *          claim is old (stale); if so, reclaim it and retry (bounded); if
 *          the claimant looks alive and just slow, fail OPEN (see below)
 *          rather than block indefinitely.
 *
 *          Residual (accepted, p2): that fail-open branch trades safety for
 *          liveness. If the OTHER claimant is genuinely alive and simply
 *          takes longer than the wait budget to dispatch + journal (e.g. a
 *          slow roadmap write), we return `shouldApply:true` and the caller
 *          dispatches too — reopening a narrow double-apply window, exactly
 *          the class of race td-034 exists to close. This is strictly
 *          rarer than the pre-td-034 race (it additionally requires the
 *          winner to outlive the full poll budget, not just lose a
 *          visibility race), and is judged an acceptable tradeoff vs.
 *          blocking the claim mechanism indefinitely.
 *   3. Fail-open: ANY error in this mechanism (unwritable `.claims/`
 *      directory, unreadable claim file, etc.) must never crash or block a
 *      mutation. It degrades to pre-td-034 behavior (apply, relying solely
 *      on the journal check) — the claim is a safety enhancement, not a new
 *      failure mode.
 *
 * Why keep the claim file after a successful apply, rather than remove it:
 * once the journal entry exists, step 1 of `applyMutation` (the fast path)
 * already dedupes every future attempt for that mutationId before this
 * module is even reached — so the claim file has no further job to do.
 * Removing it would need one more fs call in the success path and would
 * reopen (for a few microseconds) the exact EEXIST-based signal that a
 * losing racer's poll loop depends on. Leaving it costs one small file
 * forever per mutation, which is the same growth profile the journal
 * itself already has (one file per mutation, no rotation) — consistent
 * with the rest of this subsystem, not a new tradeoff.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveHubRepoRoot } from './hubRepoRoot';
import { isProcessAlive } from './discover';
import { hasJournaledMutation as realHasJournaledMutation } from './journal';

export interface ClaimRecord {
  pid: number;
  timestamp: string;
}

export interface AcquireClaimResult {
  /**
   * true: the caller should proceed to dispatch + journal the mutation —
   * either because we hold the claim, or because the claim mechanism
   * degraded (fail-open) and today's journal-only check is all we have.
   * false: another actor already applied this exact mutationId (its
   * journal entry appeared while we waited) — treat as an idempotent
   * no-op and return current state, do NOT dispatch again.
   */
  shouldApply: boolean;
}

export interface MutationClaimOptions {
  /** Injectable clock. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Injectable pid. Defaults to `process.pid`. */
  pid?: number;
  /** Injectable liveness check. Defaults to the real `process.kill(pid, 0)` probe (discover.ts). */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable idempotency check used by the poll loop. Defaults to the real `hasJournaledMutation`. Kept separate from the fast-path check in applyMutation so tests can fool ONE without fooling the other. */
  hasJournaledMutation?: (repoRoot: string, mutationId: string) => boolean;
  /** Injectable synchronous sleep for the poll loop. Defaults to a real `Atomics.wait`-based blocking sleep. Tests can use this hook to deterministically run "the other actor" mid-wait. */
  sleepImpl?: (ms: number) => void;
  /** A claim older than this (ms) is stale regardless of pid liveness. Default 30s. */
  staleMs?: number;
  /** Poll increment while waiting for the other claimant's journal entry. Default 50ms. */
  pollIntervalMs?: number;
  /** Total bounded wait per claim-contention round before checking staleness. Default 1000ms (~1s, per td-034). */
  maxWaitMs?: number;
  /** Bound on stale-claim-takeover retries, so a pathological repeated race can never loop forever. Default 5. */
  maxStaleRetries?: number;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_MAX_WAIT_MS = 1000;
const DEFAULT_MAX_STALE_RETRIES = 5;

/**
 * Hub-server claim budget (td-034 follow-up review fix) — much smaller than
 * `DEFAULT_MAX_WAIT_MS`/`DEFAULT_POLL_INTERVAL_MS`, and used ONLY at the hub
 * HTTP callsite (`routes/hubMutate.ts`), never the CLI direct-write
 * fallback.
 *
 * `acquireMutationClaim`'s poll loop sleeps via `defaultSleep`, a
 * SYNCHRONOUS `Atomics.wait` that blocks the entire Node event loop for its
 * duration — there is no way to `await` it. The hub is a long-lived server
 * multiplexing HTTP, health checks, and SSE over that one event loop, so any
 * time this function spends sleeping freezes ALL of them, not just the
 * request that hit claim contention. The CLI fallback, by contrast, is a
 * short-lived one-shot process handling a single mutation with nothing else
 * to block — it keeps the full `DEFAULT_MAX_WAIT_MS` budget.
 *
 * The scenario this budget exists for (td-034's own motivating race: the
 * hub's response to a mutation is lost, so the CLI's direct-write fallback
 * races the hub for the SAME mutationId) resolves almost immediately either
 * way: a live racing claimant journals via a synchronous local fs write
 * (fast), or that claimant already finished and this call sees the journal
 * entry on an early poll. The hub gains essentially nothing by waiting the
 * CLI's full ~1s budget in the rare case neither is true, and must not
 * freeze its event loop for that long — so it gives up fast and fails open
 * (see the module doc's "Residual (accepted, p2)" note above).
 */
export const HUB_CLAIM_MAX_WAIT_MS = 100;
export const HUB_CLAIM_POLL_INTERVAL_MS = 20;

// Mirrors journal.ts's per-repoRoot memoized `resolveHubRepoRoot` cache: this
// module is on the same hot path (every fallback-eligible mutation), and a
// long-lived hub process should pay the `git rev-parse` subprocess cost once
// per repoRoot, not once per mutation forever.
const hubRootCache = new Map<string, string>();
function hubRoot(repoRoot: string): string {
  const cached = hubRootCache.get(repoRoot);
  if (cached !== undefined) return cached;
  const resolved = resolveHubRepoRoot(repoRoot) ?? repoRoot;
  hubRootCache.set(repoRoot, resolved);
  return resolved;
}

function claimsDir(repoRoot: string): string {
  // Lives alongside the journal (`.tenbo/journal/.claims/`), under the same
  // shared hub repo root, so every worktree of one repository agrees on
  // where claims for a given mutationId live — same rationale as journal.ts.
  return path.join(hubRoot(repoRoot), '.tenbo', 'journal', '.claims');
}

function claimPath(repoRoot: string, mutationId: string): string {
  // encodeURIComponent guards against a mutationId containing path
  // separators or other filesystem-unsafe characters — mutationId arrives
  // over HTTP as caller-supplied JSON, so treat it as untrusted input for
  // filename construction, unlike the trusted timestamp in journal.ts.
  return path.join(claimsDir(repoRoot), `${encodeURIComponent(mutationId)}.claim`);
}

type CreateOutcome = 'created' | 'exists' | 'error';

function tryCreateClaim(repoRoot: string, mutationId: string, record: ClaimRecord): CreateOutcome {
  try {
    mkdirSync(claimsDir(repoRoot), { recursive: true });
    // 'wx' = exclusive create, atomic across processes on a local
    // filesystem — the same primitive next-id.ts already relies on for
    // `.tenbo/.id-locks/`.
    writeFileSync(claimPath(repoRoot, mutationId), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return 'created';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') return 'exists';
    return 'error';
  }
}

function readClaim(repoRoot: string, mutationId: string): ClaimRecord | null {
  try {
    const raw = readFileSync(claimPath(repoRoot, mutationId), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.timestamp !== 'string') return null;
    return { pid: parsed.pid, timestamp: parsed.timestamp };
  } catch {
    // Gone, unreadable, or malformed — treat as absent. The caller's retry
    // loop will simply attempt to (re)create it.
    return null;
  }
}

function isClaimStale(record: ClaimRecord, now: Date, staleMs: number, alive: (pid: number) => boolean): boolean {
  const recordedAt = new Date(record.timestamp).getTime();
  if (Number.isNaN(recordedAt)) return true; // malformed timestamp — safe to reclaim
  if (now.getTime() - recordedAt > staleMs) return true;
  return !alive(record.pid);
}

/** Blocks the event loop for `ms` — `applyMutation` and its dispatch path are fully synchronous, so the bounded poll below must be too. */
function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire (or wait out) the cross-process claim for `mutationId`. Never
 * throws — any internal fs error fails open to `{ shouldApply: true }` so a
 * broken `.claims/` directory can never block a mutation from landing.
 */
export function acquireMutationClaim(repoRoot: string, mutationId: string, opts: MutationClaimOptions = {}): AcquireClaimResult {
  const now = opts.now ?? (() => new Date());
  const pid = opts.pid ?? process.pid;
  const alive = opts.isProcessAlive ?? isProcessAlive;
  const hasJournaled = opts.hasJournaledMutation ?? realHasJournaledMutation;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxStaleRetries = opts.maxStaleRetries ?? DEFAULT_MAX_STALE_RETRIES;

  try {
    for (let attempt = 0; attempt <= maxStaleRetries; attempt++) {
      const record: ClaimRecord = { pid, timestamp: now().toISOString() };
      const outcome = tryCreateClaim(repoRoot, mutationId, record);

      if (outcome === 'error') return { shouldApply: true }; // fail open
      if (outcome === 'created') return { shouldApply: true }; // we own it

      // outcome === 'exists': another actor holds this mutationId. Do not
      // apply — poll briefly for its journal entry instead.
      let waited = 0;
      while (waited < maxWaitMs) {
        if (hasJournaled(repoRoot, mutationId)) {
          return { shouldApply: false }; // the other actor finished — idempotent no-op
        }
        sleep(pollIntervalMs);
        waited += pollIntervalMs;
      }

      // One more check right at the boundary — the last sleep may have
      // been exactly when the other actor journaled.
      if (hasJournaled(repoRoot, mutationId)) {
        return { shouldApply: false };
      }

      const existing = readClaim(repoRoot, mutationId);
      if (existing && !isClaimStale(existing, now(), staleMs, alive)) {
        // Held by a still-alive claimant, not stale — it's just slow (or
        // this poll round lost a close race). Fail open rather than block
        // forever: never let the claim mechanism itself withhold a
        // mutation indefinitely.
        return { shouldApply: true };
      }

      // Claimant is dead, its claim is stale, or the claim vanished
      // mid-check — reclaim and retry (bounded by maxStaleRetries).
      try {
        unlinkSync(claimPath(repoRoot, mutationId));
      } catch {
        // Lost the race to remove it, or it's already gone — fine, the
        // next loop iteration's tryCreateClaim will sort it out.
      }
    }

    // Exhausted the stale-retry budget (repeatedly raced another
    // reclaimer) — fail open rather than loop forever.
    return { shouldApply: true };
  } catch {
    // Belt-and-suspenders: any unexpected error anywhere in this function
    // must never propagate out of the claim mechanism. See module doc.
    return { shouldApply: true };
  }
}

/** Test-only escape hatch mirroring journal.ts's own path helpers — not used by production code. */
export function claimFilePathForTest(repoRoot: string, mutationId: string): string {
  return claimPath(repoRoot, mutationId);
}

/** Test-only: whether the claims directory exists yet. */
export function claimsDirExistsForTest(repoRoot: string): boolean {
  return existsSync(claimsDir(repoRoot));
}
