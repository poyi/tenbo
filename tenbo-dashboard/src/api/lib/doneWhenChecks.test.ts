import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_EXPECT_EXIT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  doneWhenText,
  evaluateDoneWhenEntry,
  formatCheckEvidence,
  isStructuredDoneWhen,
  resolveTimeoutMs,
  runDoneWhenChecks,
  summarizeDoneWhenResults,
} from './doneWhenChecks';
import type { DoneWhenEntry } from '../../types';

let dir: string;

function tempDir() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'tenbo-done-when-')));
}

describe('doneWhenChecks — shape helpers', () => {
  it('identifies structured vs plain-string entries', () => {
    expect(isStructuredDoneWhen('plain bullet')).toBe(false);
    expect(isStructuredDoneWhen({ text: 'has a check', check: { run: 'true' } })).toBe(true);
    // An object without `check` (defensive — validator should already reject this shape upstream) is not structured.
    expect(isStructuredDoneWhen({ text: 'no check' } as DoneWhenEntry)).toBe(false);
  });

  it('extracts human-readable text from either form', () => {
    expect(doneWhenText('plain bullet')).toBe('plain bullet');
    expect(doneWhenText({ text: 'structured bullet', check: { run: 'true' } })).toBe('structured bullet');
  });

  it('resolves timeout defaults and clamps to the hard cap', () => {
    expect(resolveTimeoutMs({ run: 'true' })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ run: 'true', timeout_ms: 5000 })).toBe(5000);
    expect(resolveTimeoutMs({ run: 'true', timeout_ms: 10_000_000 })).toBe(MAX_TIMEOUT_MS);
  });

  it('defaults expect_exit to 0 when evaluating', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), { text: 'ok', check: { run: 'exit 0' } });
    expect(result.expect_exit).toBe(DEFAULT_EXPECT_EXIT);
    expect(result.status).toBe('pass');
  });
});

describe('doneWhenChecks — execution', () => {
  it('passes when the command exits with the expected code', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), { text: 'true succeeds', check: { run: 'true' } });
    expect(result).toMatchObject({ kind: 'check', status: 'pass', exit_code: 0, expect_exit: 0, timed_out: false });
  });

  it('fails when the command exits with a code other than expect_exit', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), { text: 'false fails', check: { run: 'false' } });
    expect(result).toMatchObject({ kind: 'check', status: 'fail', exit_code: 1, expect_exit: 0, timed_out: false });
  });

  it('honors a non-zero expect_exit', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), { text: 'expects 3', check: { run: 'exit 3', expect_exit: 3 } });
    expect(result).toMatchObject({ status: 'pass', exit_code: 3, expect_exit: 3 });
  });

  it('kills a command that overruns its timeout and reports it failed', async () => {
    const start = Date.now();
    const result = await evaluateDoneWhenEntry(process.cwd(), {
      text: 'sleeps too long',
      check: { run: 'sleep 10', timeout_ms: 300 },
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe('fail');
    expect(result.timed_out).toBe(true);
    // Should not have waited anywhere near the full 10s sleep — proves the process was actually killed, not merely abandoned.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('resolves promptly when the command backgrounds a plain child that inherits stdout (does not hang on pipe EOF)', async () => {
    const start = Date.now();
    const result = await evaluateDoneWhenEntry(process.cwd(), {
      // `sh -c` exits ~immediately (no job control, so the background job
      // stays in the same process group and gets killed too) but the
      // backgrounded sleep inherits stdout/stderr and can hold the pipe
      // open — 'close' must not be required for resolution.
      text: 'backgrounds a long-lived child that inherits stdio',
      check: { run: 'sleep 30 &', timeout_ms: 500 },
    });
    const elapsed = Date.now() - start;
    // Must resolve well under the 30s the backgrounded sleep would otherwise hold
    // the pipe open for, and well under the reviewer-observed 2m44s hang.
    expect(elapsed).toBeLessThan(5000);
    expect(result.status).toBe('fail');
    expect(result.timed_out).toBe(true);
  }, 8_000);

  it('resolves promptly even when a grandchild double-forks + setsid()s into a new session that escapes the process-group kill', async () => {
    // This is the sharper repro: `python3` forks, the child calls os.setsid()
    // to join a brand-new session/process group (still holding the inherited
    // stdout fd open), and the original parent exits immediately. By the time
    // our timeout fires, `process.kill(-pid, ...)` finds NOTHING left in the
    // original group (ESRCH) — the detached grandchild is unreachable by a
    // group kill. Under the old close()-only implementation this hangs until
    // the daemon happens to exit on its own (here, ~10s; in the wild, unbounded).
    const start = Date.now();
    const result = await evaluateDoneWhenEntry(process.cwd(), {
      text: 'double-fork + setsid escapes the process group',
      check: {
        run: 'python3 -c "import os,time; os.fork() or (os.setsid(), time.sleep(10))" &',
        timeout_ms: 500,
      },
    });
    const elapsed = Date.now() - start;
    // Must resolve well under the 10s the detached daemon actually runs for.
    expect(elapsed).toBeLessThan(5000);
    expect(result.status).toBe('fail');
    expect(result.timed_out).toBe(true);
  }, 12_000);

  it('reports a plain-string entry as manual, never executing anything', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), 'Prose-only criterion');
    expect(result).toEqual({ text: 'Prose-only criterion', kind: 'manual', status: 'manual' });
  });

  it('reports a structured entry with no check as manual', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), { text: 'no check attached' } as DoneWhenEntry);
    expect(result).toEqual({ text: 'no check attached', kind: 'manual', status: 'manual' });
  });

  it('runs a mixed done_when list and reports each entry appropriately', async () => {
    const entries: DoneWhenEntry[] = [
      'Prose bullet, never executed',
      { text: 'passing check', check: { run: 'true' } },
      { text: 'failing check', check: { run: 'false' } },
    ];
    const results = await runDoneWhenChecks(process.cwd(), entries);
    expect(results.map((r) => r.status)).toEqual(['manual', 'pass', 'fail']);
    const summary = summarizeDoneWhenResults(results);
    expect(summary).toMatchObject({ passed: false, checkedCount: 2, manualCount: 1, failedCount: 1 });
  });

  it('truncates captured stdout beyond the byte cap', async () => {
    const result = await evaluateDoneWhenEntry(process.cwd(), {
      text: 'huge output',
      check: { run: 'head -c 5000 /dev/zero | tr "\\0" "a"' },
    });
    expect(result.stdout!.length).toBeLessThan(3000);
    expect(result.stdout).toContain('[truncated]');
  });

  it('runs with the given repoRoot as cwd', async () => {
    dir = tempDir();
    try {
      const result = await evaluateDoneWhenEntry(dir, { text: 'pwd check', check: { run: 'pwd' } });
      expect(result.stdout?.trim()).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doneWhenChecks — summary and evidence formatting', () => {
  it('summary is vacuously passed when there are no structured checks', () => {
    const summary = summarizeDoneWhenResults([{ text: 'a', kind: 'manual', status: 'manual' }]);
    expect(summary).toMatchObject({ passed: true, checkedCount: 0, manualCount: 1, failedCount: 0 });
  });

  it('formats evidence lines for check and manual entries', () => {
    expect(formatCheckEvidence({ text: 'a', kind: 'manual', status: 'manual' })).toBe('manual: a');
    expect(formatCheckEvidence({
      text: 'b', kind: 'check', status: 'pass', run: 'true', exit_code: 0, expect_exit: 0, timed_out: false,
    })).toBe('check: true -> exit=0 expected=0 (pass)');
    expect(formatCheckEvidence({
      text: 'c', kind: 'check', status: 'fail', run: 'sleep 10', exit_code: null, expect_exit: 0, timed_out: true,
    })).toBe('check: sleep 10 -> exit=null expected=0 (timeout (killed))');
  });
});
