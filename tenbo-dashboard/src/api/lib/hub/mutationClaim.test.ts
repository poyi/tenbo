import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireMutationClaim, claimFilePathForTest, claimsDirExistsForTest } from './mutationClaim';
import { appendJournalEvent } from './journal';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-mutationclaim-'));
  mkdirSync(path.join(dir, '.git'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Pre-seed a claim file directly, simulating another actor's in-flight or dead claim. Creates `.tenbo/journal/.claims/` first (production code only creates it lazily inside `acquireMutationClaim`). */
function seedClaim(mutationId: string, record: { pid: number; timestamp: string }): void {
  const p = claimFilePathForTest(dir, mutationId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record), { flag: 'wx' });
}

describe('acquireMutationClaim (td-034 cross-process claim)', () => {
  it('creates the claim file and returns shouldApply:true when no claim exists yet', () => {
    const result = acquireMutationClaim(dir, 'mut-fresh', { pid: 123, now: () => new Date('2026-07-11T10:00:00.000Z') });

    expect(result).toEqual({ shouldApply: true });
    expect(claimsDirExistsForTest(dir)).toBe(true);
    const record = JSON.parse(readFileSync(claimFilePathForTest(dir, 'mut-fresh'), 'utf8'));
    expect(record).toEqual({ pid: 123, timestamp: '2026-07-11T10:00:00.000Z' });
  });

  it('sanitizes mutationId into a safe filename (untrusted input)', () => {
    acquireMutationClaim(dir, '../../etc/passwd', { pid: 1 });
    const p = claimFilePathForTest(dir, '../../etc/passwd');
    // Must stay confined to the claims directory — no path traversal.
    expect(p.startsWith(path.join(dir, '.tenbo', 'journal', '.claims'))).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  it('EEXIST + journal already present -> shouldApply:false (idempotent no-op) without waiting out the full poll budget', () => {
    // Simulate: another actor already claimed AND journaled this mutationId.
    seedClaim('mut-done', { pid: 999, timestamp: new Date().toISOString() });
    appendJournalEvent(dir, { mutationId: 'mut-done', actor: 'alice', itemId: 'ed-001', operation: 'add-note' });

    const sleep = vi.fn();
    const result = acquireMutationClaim(dir, 'mut-done', { sleepImpl: sleep, maxWaitMs: 500, pollIntervalMs: 50 });

    expect(result).toEqual({ shouldApply: false });
    // Found it on the FIRST poll check — never had to sleep.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('EEXIST + journal appears mid-poll -> shouldApply:false', () => {
    seedClaim('mut-midpoll', { pid: 999, timestamp: new Date().toISOString() });

    let sleeps = 0;
    const sleep = vi.fn(() => {
      sleeps += 1;
      if (sleeps === 2) {
        // "The other actor" finishes and journals partway through our wait.
        appendJournalEvent(dir, { mutationId: 'mut-midpoll', actor: 'alice', itemId: 'ed-001', operation: 'add-note' });
      }
    });

    const result = acquireMutationClaim(dir, 'mut-midpoll', { sleepImpl: sleep, maxWaitMs: 1000, pollIntervalMs: 50 });

    expect(result).toEqual({ shouldApply: false });
    expect(sleeps).toBe(2);
  });

  it('STALE CLAIM TAKEOVER: a claim with a dead pid and no journal entry is reclaimed and applied exactly once', () => {
    const deadPid = 999_999; // presumed not alive
    seedClaim('mut-stale', { pid: deadPid, timestamp: new Date(Date.now() - 5000).toISOString() });

    const sleep = vi.fn();
    const result = acquireMutationClaim(dir, 'mut-stale', {
      pid: 42,
      sleepImpl: sleep,
      maxWaitMs: 100,
      pollIntervalMs: 20,
      isProcessAlive: (pid) => pid !== deadPid, // dead pid -> stale
    });

    expect(result).toEqual({ shouldApply: true });
    // Reclaimed: the claim file now belongs to us.
    const record = JSON.parse(readFileSync(claimFilePathForTest(dir, 'mut-stale'), 'utf8'));
    expect(record.pid).toBe(42);
  });

  it('STALE CLAIM TAKEOVER: a claim older than staleMs is reclaimed even if its pid looks alive', () => {
    seedClaim('mut-old', { pid: 999, timestamp: '2020-01-01T00:00:00.000Z' });

    const result = acquireMutationClaim(dir, 'mut-old', {
      pid: 42,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
      sleepImpl: vi.fn(),
      maxWaitMs: 50,
      pollIntervalMs: 25,
      staleMs: 30_000,
      isProcessAlive: () => true, // "alive", but the timestamp is ancient
    });

    expect(result).toEqual({ shouldApply: true });
  });

  it('does NOT reclaim a claim that is neither stale nor journaled — fails open (applies) rather than blocking forever', () => {
    seedClaim('mut-livebutslow', { pid: 999, timestamp: new Date().toISOString() });

    const sleep = vi.fn();
    const result = acquireMutationClaim(dir, 'mut-livebutslow', {
      sleepImpl: sleep,
      maxWaitMs: 100,
      pollIntervalMs: 25,
      isProcessAlive: () => true, // genuinely alive, still holding the claim
    });

    // Bounded wait elapsed, claim not stale -> fail open (never hang forever).
    expect(result).toEqual({ shouldApply: true });
    expect(sleep).toHaveBeenCalled();
  });

  it('FAIL-OPEN: an unwritable claims directory does not throw and still returns shouldApply:true', () => {
    const journalDir = path.join(dir, '.tenbo', 'journal');
    mkdirSync(journalDir, { recursive: true });
    chmodSync(journalDir, 0o500); // cannot create the .claims/ subdirectory inside

    try {
      // Root and some sandboxes bypass directory permissions — only assert
      // the fail-open contract when the OS actually enforced it.
      let blocked = true;
      try {
        mkdirSync(path.join(journalDir, 'probe'));
        rmSync(path.join(journalDir, 'probe'), { recursive: true });
        blocked = false;
      } catch {
        blocked = true;
      }
      if (!blocked) return;

      expect(() => acquireMutationClaim(dir, 'mut-unwritable')).not.toThrow();
      expect(acquireMutationClaim(dir, 'mut-unwritable')).toEqual({ shouldApply: true });
    } finally {
      chmodSync(journalDir, 0o700);
    }
  });

  it('bounds stale-claim-takeover retries instead of looping forever', () => {
    // A pathological repeated race: every time we unlink a stale claim and
    // go to reclaim it, "another actor" immediately wins the recreate race
    // first — forcing our tryCreateClaim to see EEXIST again next round.
    // `now()` is called once per attempt (to stamp the record we'd write)
    // right after the previous round's unlink and right before the next
    // create, making it the one available synchronous hook to simulate
    // that timing deterministically in a single-threaded test.
    seedClaim('mut-contended', { pid: 999_999, timestamp: '2020-01-01T00:00:00.000Z' });

    let nowCalls = 0;
    const now = () => {
      nowCalls += 1;
      if (nowCalls > 1) {
        try {
          seedClaim('mut-contended', { pid: 999_999, timestamp: '2020-01-01T00:00:00.000Z' });
        } catch {
          /* still present from a previous round — fine */
        }
      }
      return new Date('2026-07-11T10:00:00.000Z');
    };

    const result = acquireMutationClaim(dir, 'mut-contended', {
      pid: 42,
      now,
      sleepImpl: vi.fn(),
      maxWaitMs: 20,
      pollIntervalMs: 20,
      maxStaleRetries: 3,
      isProcessAlive: () => false, // always looks dead -> always stale, always attempts takeover
    });

    // Bounded — must terminate and fail open rather than loop forever, even
    // though every single takeover attempt lost the recreate race. `now()`
    // is called twice per attempt (once to stamp the record, once inside
    // the staleness check), so 4 attempts (maxStaleRetries(3) + the initial
    // attempt) means 8 calls — the key assertion is that it's bounded at
    // all, not the exact multiple.
    expect(result).toEqual({ shouldApply: true });
    expect(nowCalls).toBe(8);
  });
});
