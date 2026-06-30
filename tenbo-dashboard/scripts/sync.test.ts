import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runIndexRefreshForSync } from './sync';

const spawn = vi.fn();

beforeEach(() => {
  spawn.mockReset();
});

describe('sync index refresh', () => {
  it('runs index refresh with a bounded timeout', () => {
    spawn.mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"mode":"reuse"}',
      stderr: '',
      signal: null,
      pid: 1,
      output: [null, '{"ok":true,"mode":"reuse"}', ''],
    });

    const result = runIndexRefreshForSync('/repo', 3000, spawn);

    expect(result.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(['index', '--if-stale', '--json']),
      expect.objectContaining({
        cwd: '/repo',
        timeout: 3000,
      }),
    );
  });

  it('fails open when index refresh times out', () => {
    spawn.mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      pid: 1,
      output: [null, '', ''],
      error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
    });

    const result = runIndexRefreshForSync('/repo', 3000, spawn);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('timed out');
  });
});
