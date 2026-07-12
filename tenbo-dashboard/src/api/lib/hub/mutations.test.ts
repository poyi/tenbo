import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { applyMutation } from './mutations';
import { appendJournalEvent, readJournal } from './journal';
import { claimFilePathForTest, HUB_CLAIM_MAX_WAIT_MS, HUB_CLAIM_POLL_INTERVAL_MS } from './mutationClaim';
import { addItemNote, findItem } from '../roadmapStore';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-mutations-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor scope\ncross_cutting: []\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/architecture.yaml'), 'layers:\n  - id: app\n    name: App\n    description: application layer\n    files: ["src/**"]\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(dir, '.tenbo/overview.md'), '# Overview\n');
  writeFileSync(path.join(dir, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: next',
    '    description: first item',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('applyMutation (td-030 attribution + journal + idempotency)', () => {
  it('stamps the note with the resolved agent and journals the mutation', () => {
    const result = applyMutation(dir, { op: 'add-note', itemId: 'ed-001', note: 'hi', mutationId: 'mut-1', agent: 'alice' });

    expect(result.item.notes).toContain('[alice]: hi');

    const events = readJournal(dir, { itemId: 'ed-001' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ mutationId: 'mut-1', actor: 'alice', itemId: 'ed-001', operation: 'add-note' });
    expect(typeof events[0].timestamp).toBe('string');
    expect(new Date(events[0].timestamp).toString()).not.toBe('Invalid Date');
  });

  it('stamps verification evidence with the resolved agent', () => {
    const result = applyMutation(dir, {
      op: 'verify',
      itemId: 'ed-001',
      status: 'verified',
      evidence: ['npm test -- --run'],
      mutationId: 'mut-2',
      agent: 'bob',
    });

    expect(result.item.verification).toMatchObject({ status: 'verified', actor: 'bob', evidence: ['npm test -- --run'] });
  });

  it('stamps the completion note and verification with the resolved agent', () => {
    const result = applyMutation(dir, {
      op: 'complete',
      itemId: 'ed-001',
      evidence: ['npm test -- --run'],
      mutationId: 'mut-3',
      agent: 'carol',
    });

    expect(result.item.notes).toContain('[carol]: Completed with evidence: npm test -- --run');
    expect(result.item.verification).toMatchObject({ actor: 'carol' });
  });

  it('journals distinct mutation ids independently — each is applied exactly once', () => {
    applyMutation(dir, { op: 'add-note', itemId: 'ed-001', note: 'first', mutationId: 'mut-a', agent: 'alice' });
    applyMutation(dir, { op: 'add-note', itemId: 'ed-001', note: 'second', mutationId: 'mut-b', agent: 'alice' });

    const located = findItem(dir, 'ed-001');
    expect(located.item.notes).toContain('first');
    expect(located.item.notes).toContain('second');
    expect(readJournal(dir, { itemId: 'ed-001' })).toHaveLength(2);
  });

  it('IDEMPOTENCY: replaying the same mutation id (lost hub response -> CLI fallback retry) does not double-apply', () => {
    const req = { op: 'add-note' as const, itemId: 'ed-001', note: 'hi', mutationId: 'mut-replay', agent: 'alice' };

    const first = applyMutation(dir, req);
    const second = applyMutation(dir, req); // simulates the fallback re-apply after a lost hub response

    expect(second.item.notes).toBe(first.item.notes);
    const hiLines = (second.item.notes ?? '').split('\n').filter((line) => line.includes('hi'));
    expect(hiLines).toHaveLength(1); // NOT double-appended

    expect(readJournal(dir, { mutationId: 'mut-replay' })).toHaveLength(1); // NOT double-journaled
  });

  it('IDEMPOTENCY: a replayed complete does not re-append the completion note or re-flip status', () => {
    const req = {
      op: 'complete' as const,
      itemId: 'ed-001',
      evidence: ['npm test -- --run'],
      mutationId: 'mut-complete-replay',
      agent: 'alice',
    };

    applyMutation(dir, req);
    const replayed = applyMutation(dir, req);

    expect(replayed.item.status).toBe('done');
    const completedLines = (replayed.item.notes ?? '').split('\n').filter((line) => line.includes('Completed with evidence'));
    expect(completedLines).toHaveLength(1);
    expect(readJournal(dir, { mutationId: 'mut-complete-replay' })).toHaveLength(1);
  });

  it('BLOCKER regression: a journal-write failure (read-only journal dir) does not fail an otherwise-successful mutation', () => {
    // Exact reviewer repro: make .tenbo/journal read-only so
    // appendJournalEvent's writeFileSync throws AFTER dispatchMutation has
    // already committed the roadmap write. applyMutation must swallow that
    // failure (best-effort journaling) and still return the successful
    // WriteResult — never rethrow and undo/fail an already-committed write.
    const journalPath = path.join(dir, '.tenbo', 'journal');
    mkdirSync(journalPath, { recursive: true });
    chmodSync(journalPath, 0o500); // read+execute only: cannot create new files inside

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = applyMutation(dir, { op: 'add-note', itemId: 'ed-001', note: 'hi', mutationId: 'mut-blocker', agent: 'alice' });

      // (a) the roadmap write succeeded and was returned, despite the journal failure.
      expect(result.item.notes).toContain('[alice]: hi');
      const located = findItem(dir, 'ed-001');
      expect(located.item.notes).toContain('[alice]: hi');

      // The failure was logged, not swallowed silently.
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('warning: failed to journal mutation mut-blocker'));
    } finally {
      chmodSync(journalPath, 0o700);
      stderrSpy.mockRestore();
    }
  });

  describe('td-034: cross-process claim closes the residual idempotency race', () => {
    it('RACE (wiring/integration): the create-race loser waits on the winner\'s claim and applies exactly once', () => {
      // Complements the PRIMARY race proof below by exercising the SAME
      // detect-a-concurrently-finishing-owner behavior that
      // mutationClaim.test.ts unit-tests in isolation, but wired end to end
      // through applyMutation: actor A (e.g. the hub) already won the
      // claim-create race but has NOT dispatched or journaled yet —
      // simulated here by pre-seeding the claim file exactly as a real
      // `tryCreateClaim` success would leave it. Actor B (this applyMutation
      // call, e.g. the CLI's direct-write fallback) starts with a genuinely
      // unjournaled mutationId (no mocking of hasJournaledMutation anywhere
      // in this test), so its own fast-path check correctly says "not
      // journaled yet" — the ONLY thing standing between B and a duplicate
      // apply is the claim mechanism under test. (Because this uses the
      // `claim.sleepImpl` injection point that only exists in the td-034
      // code path, it can't literally be re-run unmodified against pre-fix
      // code — see the test below for that black-box before/after proof.)
      const mutationId = 'mut-truerace';
      const req = { op: 'add-note' as const, itemId: 'ed-001', note: 'race-note', mutationId, agent: 'alice' };

      const claimPath = claimFilePathForTest(dir, mutationId);
      mkdirSync(path.dirname(claimPath), { recursive: true });
      writeFileSync(claimPath, JSON.stringify({ pid: 111, timestamp: new Date().toISOString() }), { flag: 'wx' });

      let actorAFinished = false;
      const result = applyMutation(dir, req, {
        claim: {
          pollIntervalMs: 10,
          maxWaitMs: 500,
          sleepImpl: () => {
            if (actorAFinished) return;
            actorAFinished = true;
            // Actor A (the real owner of the pre-seeded claim above) now
            // finishes its own apply + journal WHILE actor B (this
            // applyMutation call) is blocked inside its poll loop —
            // deterministically simulating two processes racing the same
            // mutationId in a single-threaded test. This calls the exact
            // same primitives dispatchMutation/appendJournalEvent use.
            addItemNote(dir, 'ed-001', 'race-note', { actor: 'alice' });
            appendJournalEvent(dir, { mutationId, actor: 'alice', itemId: 'ed-001', operation: 'add-note' });
          },
        },
      });

      // Applied EXACTLY once: one journal entry, one note — not two.
      expect(readJournal(dir, { mutationId })).toHaveLength(1);
      const raceLines = (result.item.notes ?? '').split('\n').filter((line) => line.includes('race-note'));
      expect(raceLines).toHaveLength(1);
    });

    it('RACE (PRIMARY black-box proof): a journal-visibility-lag window in the fast-path check is still closed by the claim, exactly once', () => {
      // Reproduces the exact scenario in the td-034 description: the hub
      // applies + journals a mutation, but the CLI fallback's OWN
      // `hasJournaledMutation` check flakes and reports "not journaled" for
      // this one call — forced here via the injectable fast-path override.
      // The poll loop's `hasJournaledMutation` call is the REAL one
      // (unmocked), so this proves it — not journal-check luck — is what
      // prevents the double apply. Verified (by temporarily reverting the
      // claim step in applyMutation to a no-op) that this test FAILS on
      // pre-td-034 code with a duplicated note and two journal entries, and
      // passes once the claim step is restored — a genuine before/after
      // regression proof, not a mechanism-internals test.
      const req = { op: 'add-note' as const, itemId: 'ed-001', note: 'lag-note', mutationId: 'mut-lag', agent: 'alice' };

      const first = applyMutation(dir, req); // actor A: applies + journals normally
      const second = applyMutation(dir, req, { hasJournaledMutation: () => false }); // actor B: fast path fooled

      expect(second.item.notes).toBe(first.item.notes);
      const lagLines = (second.item.notes ?? '').split('\n').filter((line) => line.includes('lag-note'));
      expect(lagLines).toHaveLength(1);
      expect(readJournal(dir, { mutationId: 'mut-lag' })).toHaveLength(1);
    });

    it('STALE CLAIM TAKEOVER: reclaims a dead claimant\'s stale claim (no journal entry) and applies exactly once', () => {
      const mutationId = 'mut-staleapply';
      const claimPath = claimFilePathForTest(dir, mutationId);
      mkdirSync(path.dirname(claimPath), { recursive: true });
      // A claim from a pid that is (almost certainly) not alive, well past
      // any reasonable stale threshold, with no corresponding journal entry
      // — the claimant died mid-apply.
      writeFileSync(claimPath, JSON.stringify({ pid: 999_999, timestamp: new Date(Date.now() - 120_000).toISOString() }), { flag: 'wx' });

      const result = applyMutation(
        dir,
        { op: 'add-note', itemId: 'ed-001', note: 'recovered', mutationId, agent: 'alice' },
        { claim: { maxWaitMs: 50, pollIntervalMs: 10, staleMs: 30_000 } },
      );

      expect(result.item.notes).toContain('recovered');
      expect(readJournal(dir, { mutationId })).toHaveLength(1); // applied exactly once — not lost, not doubled
      const claimRecord = JSON.parse(readFileSync(claimPath, 'utf8'));
      expect(claimRecord.pid).toBe(process.pid); // the claim now belongs to us
    });

    it('FAIL-OPEN: an unwritable .claims/ directory does not throw and does not block the mutation from applying', () => {
      const claimsPath = path.join(dir, '.tenbo', 'journal', '.claims');
      mkdirSync(claimsPath, { recursive: true });
      chmodSync(claimsPath, 0o500); // read+execute only: cannot create a claim file inside

      try {
        // Root and some CI sandboxes bypass directory permissions — only
        // assert the fail-open contract when the OS actually enforced it.
        let blocked = true;
        try {
          writeFileSync(path.join(claimsPath, 'probe.claim'), '{}', { flag: 'wx' });
          rmSync(path.join(claimsPath, 'probe.claim'));
          blocked = false;
        } catch {
          blocked = true;
        }
        if (!blocked) return;

        const result = applyMutation(dir, { op: 'add-note', itemId: 'ed-001', note: 'failopen', mutationId: 'mut-failopen', agent: 'alice' });

        expect(result.item.notes).toContain('failopen');
        // The journal itself is untouched by this test (only .claims/ is
        // unwritable), so journaling still succeeds normally.
        expect(readJournal(dir, { mutationId: 'mut-failopen' })).toHaveLength(1);
      } finally {
        chmodSync(claimsPath, 0o700);
      }
    });

    it(
      "HUB BUDGET (review follow-up): a hub-sized claim wait (HUB_CLAIM_MAX_WAIT_MS/POLL_INTERVAL_MS) racing a live, never-journaling external claimant is bounded to the hub's small budget, not the CLI fallback's 1s default",
      () => {
        const mutationId = 'mut-hubbudget';
        const claimPath = claimFilePathForTest(dir, mutationId);
        mkdirSync(path.dirname(claimPath), { recursive: true });
        // A live (not stale) external claimant that never journals within
        // the wait window — e.g. the CLI's own direct-write fallback racing
        // the hub for the SAME mutationId, exactly td-034's motivating
        // scenario, just slow enough that this call's wait elapses first.
        writeFileSync(claimPath, JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }), { flag: 'wx' });

        const sleep = vi.fn();
        const result = applyMutation(
          dir,
          { op: 'add-note', itemId: 'ed-001', note: 'hub-fail-open', mutationId, agent: 'alice' },
          {
            // Exactly what routes/hubMutate.ts wires at the hub callsite —
            // see HUB_CLAIM_OPTIONS there.
            claim: {
              maxWaitMs: HUB_CLAIM_MAX_WAIT_MS,
              pollIntervalMs: HUB_CLAIM_POLL_INTERVAL_MS,
              sleepImpl: sleep,
              isProcessAlive: () => true, // genuinely alive, still holding the claim
            },
          },
        );

        // Fails open (claimant alive, not stale, never journaled within the
        // budget) and applies — same OUTCOME the CLI's 1s budget would also
        // reach, but bounded to the hub's much smaller wait: exactly
        // maxWaitMs / pollIntervalMs poll iterations, not 1000/50=20.
        expect(result.item.notes).toContain('hub-fail-open');
        const expectedPolls = HUB_CLAIM_MAX_WAIT_MS / HUB_CLAIM_POLL_INTERVAL_MS;
        expect(expectedPolls).toBeLessThan(20); // sanity: genuinely smaller than the CLI's 1000/50 default
        expect(sleep).toHaveBeenCalledTimes(expectedPolls);
        expect(sleep).toHaveBeenCalledWith(HUB_CLAIM_POLL_INTERVAL_MS);
      },
    );
  });
});
