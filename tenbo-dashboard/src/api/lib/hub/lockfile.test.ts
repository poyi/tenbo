import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  HUB_SCHEMA_VERSION,
  canonicalRepoRoot,
  readHubLockfile,
  removeHubLockfile,
  writeHubLockfile,
} from './lockfile';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-lockfile-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('hub lockfile', () => {
  it('writes a descriptor with pid, port, canonical repoRoot, startedAt, schemaVersion', () => {
    const descriptor = writeHubLockfile(dir, 5174);

    expect(descriptor).toMatchObject({
      pid: process.pid,
      port: 5174,
      repoRoot: canonicalRepoRoot(dir),
      schemaVersion: HUB_SCHEMA_VERSION,
    });
    expect(typeof descriptor.startedAt).toBe('string');
    expect(new Date(descriptor.startedAt).toString()).not.toBe('Invalid Date');
  });

  it('lands the lockfile under .tenbo/cache/hub.json', () => {
    writeHubLockfile(dir, 5174);
    const file = path.join(dir, '.tenbo', 'cache', 'hub.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ port: 5174 });
  });

  it('creates .tenbo/cache/ if it does not exist yet', () => {
    // dir has no .tenbo at all — writeHubLockfile must mkdir -p.
    expect(existsSync(path.join(dir, '.tenbo'))).toBe(false);
    writeHubLockfile(dir, 5175);
    expect(readHubLockfile(dir)).toMatchObject({ port: 5175 });
  });

  it('round-trips through readHubLockfile', () => {
    writeHubLockfile(dir, 5176);
    expect(readHubLockfile(dir)).toMatchObject({ port: 5176, pid: process.pid });
  });

  it('returns null when no lockfile exists', () => {
    expect(readHubLockfile(dir)).toBeNull();
  });

  it('returns null for a malformed lockfile instead of throwing', () => {
    mkdirSync(path.join(dir, '.tenbo', 'cache'), { recursive: true });
    writeFileSync(path.join(dir, '.tenbo', 'cache', 'hub.json'), 'not json at all');
    expect(readHubLockfile(dir)).toBeNull();
  });

  it('returns null for a lockfile missing required fields', () => {
    mkdirSync(path.join(dir, '.tenbo', 'cache'), { recursive: true });
    writeFileSync(path.join(dir, '.tenbo', 'cache', 'hub.json'), JSON.stringify({ pid: 123 }));
    expect(readHubLockfile(dir)).toBeNull();
  });

  it('removeHubLockfile deletes the file and is idempotent', () => {
    writeHubLockfile(dir, 5177);
    const file = path.join(dir, '.tenbo', 'cache', 'hub.json');
    expect(existsSync(file)).toBe(true);

    removeHubLockfile(dir);
    expect(existsSync(file)).toBe(false);

    // Calling again on an already-removed lockfile must not throw.
    expect(() => removeHubLockfile(dir)).not.toThrow();
  });

  it('canonicalRepoRoot resolves symlinked paths to the same value', () => {
    const real = mkdtempSync(path.join(tmpdir(), 'tenbo-hub-real-'));
    const link = path.join(dir, 'link-to-real');
    try {
      symlinkSync(real, link);
      expect(canonicalRepoRoot(link)).toBe(realpathSync(real));
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});
