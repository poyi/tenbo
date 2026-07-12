import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { maybeAutostartHub, resetAutostartNotifiedForTests, AUTOSTART_NOTE } from './autostart';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-autostart-'));
  resetAutostartNotifiedForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fake "child process" shape good enough for maybeAutostartHub's `.unref()` call. */
function fakeChild() {
  return { unref: vi.fn() };
}

describe('maybeAutostartHub (td-038)', () => {
  it('invokes the injected spawn with `hub ensure` args, detached, when no hub was found and TENBO_NO_AUTOSTART is unset', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const notify = vi.fn();

    maybeAutostartHub(dir, { spawnImpl, env: {}, notify });

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/tenbo-dashboard\.mjs$/);
    expect(args.slice(1)).toEqual(['hub', 'ensure']);
    expect(options).toMatchObject({ cwd: dir, detached: true });
    expect(Array.isArray(options.stdio)).toBe(true);
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('emits the one-time note exactly once per process, not on a second call', () => {
    const notify = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());

    maybeAutostartHub(dir, { spawnImpl, env: {}, notify });
    maybeAutostartHub(dir, { spawnImpl, env: {}, notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(AUTOSTART_NOTE);
    expect(AUTOSTART_NOTE).toContain('TENBO_NO_AUTOSTART=1');
    // But both calls still spawned — the note is a once-per-process log, not
    // a gate on the autostart attempt itself.
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it('writes the note to stderr by default (never stdout)', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      maybeAutostartHub(dir, { spawnImpl, env: {} });
      expect(stderrSpy).toHaveBeenCalledWith(AUTOSTART_NOTE);
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('does NOT spawn when TENBO_NO_AUTOSTART is set to any non-empty value', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const notify = vi.fn();

    maybeAutostartHub(dir, { spawnImpl, env: { TENBO_NO_AUTOSTART: '1' }, notify });
    maybeAutostartHub(dir, { spawnImpl, env: { TENBO_NO_AUTOSTART: 'true' }, notify });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails open: a throwing injected spawn never propagates', () => {
    const spawnImpl = vi.fn().mockImplementation(() => {
      throw new Error('spawn EMFILE');
    });
    const notify = vi.fn();

    expect(() => maybeAutostartHub(dir, { spawnImpl, env: {}, notify })).not.toThrow();
    // The failed attempt doesn't get to log the note either — nothing was
    // actually started.
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails open even when the repo root cannot be written to (mkdirSync throws)', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const bogusRoot = path.join(dir, 'does', 'not', 'exist', '\0bad');

    expect(() => maybeAutostartHub(bogusRoot, { spawnImpl, env: {} })).not.toThrow();
  });

  it('returns synchronously (void) — no health-poll or awaited work happens on the autostart path', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const result = maybeAutostartHub(dir, { spawnImpl, env: {}, notify: vi.fn() });
    // If this were async (e.g. polling discoverHub like `hub ensure` does),
    // it would return a Promise instead of undefined.
    expect(result).toBeUndefined();
  });

  it('redirects spawned stdio to .tenbo/cache/hub.log rather than inheriting the parent process stdio', () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    maybeAutostartHub(dir, { spawnImpl, env: {}, notify: vi.fn() });

    const logPath = path.join(dir, '.tenbo', 'cache', 'hub.log');
    expect(existsSync(logPath)).toBe(true);
    // stdio[1]/[2] passed to spawnImpl are numeric fds (opened against that
    // log file), not 'inherit'.
    const [, , options] = spawnImpl.mock.calls[0];
    expect(typeof options.stdio[1]).toBe('number');
    expect(typeof options.stdio[2]).toBe('number');
    // Sanity: the log file exists on disk at the expected path (content is
    // opaque here since nothing was actually written to the fd by this test).
    expect(() => readFileSync(logPath)).not.toThrow();
  });
});
