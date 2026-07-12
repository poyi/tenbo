import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { appendJournalEvent, hasJournaledMutation, readJournal } from './journal';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-journal-'));
  mkdirSync(path.join(dir, '.git'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('journal (td-030 append-only event journal)', () => {
  it('writes one file per event under .tenbo/journal, named <timestamp>-<pid>-<counter>.json', () => {
    appendJournalEvent(
      dir,
      { mutationId: 'm1', actor: 'alice', itemId: 'ed-001', operation: 'add-note' },
      { now: () => new Date('2026-07-11T10:00:00.000Z'), pid: 111, counter: () => 1 },
    );

    const files = readdirSync(path.join(dir, '.tenbo', 'journal'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe('2026-07-11T10-00-00-000Z-111-1.json');

    const parsed = JSON.parse(readFileSync(path.join(dir, '.tenbo', 'journal', files[0]), 'utf8'));
    expect(parsed).toEqual({
      mutationId: 'm1',
      actor: 'alice',
      itemId: 'ed-001',
      operation: 'add-note',
      timestamp: '2026-07-11T10:00:00.000Z',
    });
  });

  it('never rewrites or appends to an existing event file — it is append-only', () => {
    // No file-mutation API exists on this module at all: appendJournalEvent
    // always creates a brand NEW file. This test documents that by writing
    // two events and confirming both files exist independently, byte for
    // byte, rather than one file growing.
    appendJournalEvent(dir, { mutationId: 'm1', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, { now: () => new Date('2026-07-11T10:00:00.000Z'), pid: 1, counter: () => 1 });
    appendJournalEvent(dir, { mutationId: 'm2', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, { now: () => new Date('2026-07-11T10:00:01.000Z'), pid: 1, counter: () => 2 });

    const files = readdirSync(path.join(dir, '.tenbo', 'journal'));
    expect(files).toHaveLength(2);
  });

  it('readJournal returns events sorted oldest-first, filterable by itemId and mutationId', () => {
    appendJournalEvent(dir, { mutationId: 'm1', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, { now: () => new Date('2026-07-11T10:00:00.000Z'), pid: 1, counter: () => 1 });
    appendJournalEvent(dir, { mutationId: 'm2', actor: 'bob', itemId: 'ed-002', operation: 'set-status' }, { now: () => new Date('2026-07-11T09:00:00.000Z'), pid: 1, counter: () => 2 });
    appendJournalEvent(dir, { mutationId: 'm3', actor: 'alice', itemId: 'ed-001', operation: 'complete' }, { now: () => new Date('2026-07-11T11:00:00.000Z'), pid: 1, counter: () => 3 });

    expect(readJournal(dir).map((e) => e.mutationId)).toEqual(['m2', 'm1', 'm3']);
    expect(readJournal(dir, { itemId: 'ed-001' }).map((e) => e.mutationId)).toEqual(['m1', 'm3']);
    expect(readJournal(dir, { mutationId: 'm2' }).map((e) => e.mutationId)).toEqual(['m2']);

    expect(hasJournaledMutation(dir, 'm2')).toBe(true);
    expect(hasJournaledMutation(dir, 'does-not-exist')).toBe(false);
  });

  it('returns an empty array when the journal directory does not exist yet', () => {
    expect(readJournal(dir)).toEqual([]);
    expect(hasJournaledMutation(dir, 'anything')).toBe(false);
  });

  it('skips malformed event files instead of throwing', () => {
    const journalDir = path.join(dir, '.tenbo', 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(path.join(journalDir, 'broken.json'), 'not json');
    appendJournalEvent(dir, { mutationId: 'm1', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, { now: () => new Date('2026-07-11T10:00:00.000Z'), pid: 1, counter: () => 1 });

    expect(readJournal(dir)).toHaveLength(1);
  });

  it('CONCURRENCY: many simulated concurrent writers (distinct pids, identical timestamp) never collide or lose an event', async () => {
    const N = 50;
    const fixedNow = () => new Date('2026-07-11T12:00:00.000Z'); // worst case: every writer stamps the SAME instant
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          appendJournalEvent(
            dir,
            { mutationId: `m-${i}`, actor: `agent-${i % 5}`, itemId: 'ed-001', operation: 'add-note' },
            { now: fixedNow, pid: 1000 + i, counter: () => 1 },
          ),
        ),
      ),
    );

    const events = readJournal(dir, { itemId: 'ed-001' });
    expect(events).toHaveLength(N);
    expect(new Set(events.map((e) => e.mutationId)).size).toBe(N);
  });

  it('CONCURRENCY: same pid, same timestamp — the monotonic counter still avoids collisions', () => {
    const fixedNow = () => new Date('2026-07-11T12:00:00.000Z');
    for (let i = 0; i < 20; i++) {
      // No counter override: exercises the REAL module-level monotonic
      // counter across repeated calls from a single simulated process.
      appendJournalEvent(dir, { mutationId: `same-pid-${i}`, actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, { now: fixedNow, pid: 42 });
    }
    expect(readJournal(dir, { itemId: 'ed-001' })).toHaveLength(20);
  });

  it('SHOULD-FIX 1: fails open (treats as empty) instead of throwing when the journal path is not a readable directory', () => {
    // Directory-level failure — as opposed to the already-guarded per-file
    // parse failure above — e.g. the journal path got replaced by a plain
    // file, or is unreadable. `hasJournaledMutation` runs BEFORE the
    // roadmap write in applyMutation, so letting this throw would block
    // every mutation on a broken journal directory.
    const journalPath = path.join(dir, '.tenbo', 'journal');
    mkdirSync(path.dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, 'not a directory'); // readdirSync on this throws ENOTDIR

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readJournal(dir)).toEqual([]);
      expect(hasJournaledMutation(dir, 'anything')).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('warning: unable to read journal directory'));
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('SHOULD-FIX 1: fails open when the journal directory is unreadable (permission denied)', () => {
    const journalPath = path.join(dir, '.tenbo', 'journal');
    mkdirSync(journalPath, { recursive: true });
    writeFileSync(path.join(journalPath, 'placeholder.json'), '{}'); // would be picked up if readable
    chmodSync(journalPath, 0o000); // no read/execute permission at all

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Root (and some CI sandboxes) can bypass directory permissions —
      // only assert the fail-open contract when the OS actually enforced it.
      const blocked = (() => {
        try {
          readdirSync(journalPath);
          return false;
        } catch {
          return true;
        }
      })();
      if (!blocked) return;

      expect(readJournal(dir)).toEqual([]);
      expect(hasJournaledMutation(dir, 'anything')).toBe(false);
    } finally {
      chmodSync(journalPath, 0o700);
      stderrSpy.mockRestore();
    }
  });

  it('fails loudly instead of silently clobbering on a genuine filename collision (defensive belt-and-suspenders)', () => {
    const opts = { now: () => new Date('2026-07-11T12:00:00.000Z'), pid: 999, counter: () => 7 };
    appendJournalEvent(dir, { mutationId: 'a', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, opts);
    expect(() =>
      appendJournalEvent(dir, { mutationId: 'b', actor: 'alice', itemId: 'ed-001', operation: 'add-note' }, opts),
    ).toThrow();
    // The FIRST event must be untouched — no silent overwrite.
    expect(readJournal(dir, { itemId: 'ed-001' }).map((e) => e.mutationId)).toEqual(['a']);
  });
});
