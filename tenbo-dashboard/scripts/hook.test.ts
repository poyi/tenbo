import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planInstall,
  applyInstall,
  planUninstall,
  applyUninstall,
  formatInstallPlan,
  stripHuskyBlock,
  TENBO_HEADER_MARKER,
  TENBO_HUSKY_BEGIN,
  TENBO_HUSKY_END,
  HOOK_BODY,
} from './hook';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenbo-hook-'));
  fs.mkdirSync(path.join(tmp, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('planInstall', () => {
  it('plans a standalone install when no pre-commit hook exists', () => {
    const plan = planInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('standalone');
    expect(plan.writes).toHaveLength(1);
    expect(plan.moves).toHaveLength(0);
  });

  it('detects an already-installed tenbo hook (header present)', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, `#!/usr/bin/env sh\n${TENBO_HEADER_MARKER}\necho hi\n`);
    const plan = planInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('already-installed');
    expect(plan.writes).toHaveLength(0);
  });

  it('chains a foreign hook by moving it aside to .local', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign\n');
    const plan = planInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('chained');
    expect(plan.moves[0].to.endsWith('.local')).toBe(true);
  });

  it('--force overwrites a foreign hook in place', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign\n');
    const plan = planInstall({ repoRoot: tmp, force: true });
    expect(plan.mode).toBe('standalone');
    expect(plan.moves).toHaveLength(0);
  });

  it('prefers husky integration when .husky/pre-commit exists', () => {
    const huskyPath = path.join(tmp, '.husky', 'pre-commit');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    fs.writeFileSync(huskyPath, '#!/bin/sh\nnpx lint-staged\n');
    const plan = planInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('husky');
    expect(plan.writes[0].path).toBe(huskyPath);
  });
});

describe('applyInstall + applyUninstall round-trip', () => {
  it('standalone install creates an executable hook with the tenbo header', () => {
    const plan = planInstall({ repoRoot: tmp });
    applyInstall(plan);
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    const body = fs.readFileSync(hookPath, 'utf8');
    expect(body).toBe(HOOK_BODY);
    expect(body).toContain(TENBO_HEADER_MARKER);
    expect((fs.statSync(hookPath).mode & 0o111) !== 0).toBe(true);
  });

  it('chained install preserves the foreign hook at .local and restores on uninstall', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'pre-commit');
    const original = '#!/bin/sh\necho foreign-hook\n';
    fs.writeFileSync(hookPath, original);
    fs.chmodSync(hookPath, 0o755);

    applyInstall(planInstall({ repoRoot: tmp }));
    expect(fs.readFileSync(hookPath + '.local', 'utf8')).toBe(original);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain(TENBO_HEADER_MARKER);

    applyUninstall(planUninstall(tmp));
    expect(fs.existsSync(hookPath + '.local')).toBe(false);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
  });

  it('husky install appends a delimited block; uninstall removes only that block', () => {
    const huskyPath = path.join(tmp, '.husky', 'pre-commit');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    const original = '#!/bin/sh\nnpx lint-staged\n';
    fs.writeFileSync(huskyPath, original);

    applyInstall(planInstall({ repoRoot: tmp }));
    const after = fs.readFileSync(huskyPath, 'utf8');
    expect(after).toContain(TENBO_HUSKY_BEGIN);
    expect(after).toContain(TENBO_HUSKY_END);
    expect(after).toContain('npx lint-staged');

    applyUninstall(planUninstall(tmp));
    const restored = fs.readFileSync(huskyPath, 'utf8');
    expect(restored).not.toContain(TENBO_HUSKY_BEGIN);
    expect(restored).toContain('npx lint-staged');
  });
});

describe('planUninstall', () => {
  it('reports not-installed when no hook exists', () => {
    expect(planUninstall(tmp).mode).toBe('not-installed');
  });

  it('leaves foreign hooks alone (not-installed)', () => {
    fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho foreign\n');
    expect(planUninstall(tmp).mode).toBe('not-installed');
  });
});

describe('stripHuskyBlock', () => {
  it('removes only the tenbo block, preserving surrounding lines', () => {
    const input = `line one\n\n${TENBO_HUSKY_BEGIN}\necho tenbo\n${TENBO_HUSKY_END}\nline two\n`;
    const out = stripHuskyBlock(input);
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).not.toContain('echo tenbo');
    expect(out).not.toContain(TENBO_HUSKY_BEGIN);
  });
});

describe('formatInstallPlan', () => {
  it('renders a standalone plan with mode + writes', () => {
    const out = formatInstallPlan(planInstall({ repoRoot: tmp }));
    expect(out).toContain('Install mode: standalone');
    expect(out).toContain('write:');
  });
});
