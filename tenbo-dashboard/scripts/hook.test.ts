import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  planPrepareCommitMsgInstall,
  applyPrepareCommitMsgInstall,
  planPrepareCommitMsgUninstall,
  applyPrepareCommitMsgUninstall,
  stripPrepareCommitMsgHuskyBlock,
  PREPARE_COMMIT_MSG_HEADER_MARKER,
  PREPARE_COMMIT_MSG_HUSKY_BEGIN,
  PREPARE_COMMIT_MSG_HUSKY_END,
  PREPARE_COMMIT_MSG_HOOK_BODY,
  planPostCommitInstall,
  applyPostCommitInstall,
  planPostCommitUninstall,
  applyPostCommitUninstall,
  stripPostCommitHuskyBlock,
  POST_COMMIT_HEADER_MARKER,
  POST_COMMIT_HUSKY_BEGIN,
  POST_COMMIT_HUSKY_END,
  POST_COMMIT_HOOK_BODY,
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

describe('planPrepareCommitMsgInstall (td-025, opt-in, independent of pre-commit)', () => {
  it('plans a standalone install when no prepare-commit-msg hook exists', () => {
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('standalone');
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].path).toBe(path.join(tmp, '.git', 'hooks', 'prepare-commit-msg'));
  });

  it('does not consider an installed pre-commit hook as prepare-commit-msg being installed', () => {
    applyInstall(planInstall({ repoRoot: tmp }));
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('standalone');
  });

  it('detects an already-installed tenbo prepare-commit-msg hook (header present)', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'prepare-commit-msg');
    fs.writeFileSync(hookPath, `#!/usr/bin/env sh\n${PREPARE_COMMIT_MSG_HEADER_MARKER}\necho hi\n`);
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('already-installed');
  });

  it('chains a foreign prepare-commit-msg hook by moving it aside to .local', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'prepare-commit-msg');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign\n');
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('chained');
    expect(plan.moves[0].to.endsWith('.local')).toBe(true);
  });

  it('prefers husky integration when .husky/prepare-commit-msg exists', () => {
    const huskyPath = path.join(tmp, '.husky', 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    fs.writeFileSync(huskyPath, '#!/bin/sh\necho existing\n');
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('husky');
    expect(plan.writes[0].path).toBe(huskyPath);
  });

  it('standalone install creates an executable hook with the tenbo header', () => {
    const plan = planPrepareCommitMsgInstall({ repoRoot: tmp });
    applyPrepareCommitMsgInstall(plan);
    const hookPath = path.join(tmp, '.git', 'hooks', 'prepare-commit-msg');
    const body = fs.readFileSync(hookPath, 'utf8');
    expect(body).toBe(PREPARE_COMMIT_MSG_HOOK_BODY);
    expect(body).toContain(PREPARE_COMMIT_MSG_HEADER_MARKER);
    expect(body).toContain('exit 0');
    expect((fs.statSync(hookPath).mode & 0o111) !== 0).toBe(true);
  });

  it('chained install preserves the foreign hook at .local and restores on uninstall', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'prepare-commit-msg');
    const original = '#!/bin/sh\necho foreign-hook\n';
    fs.writeFileSync(hookPath, original);
    fs.chmodSync(hookPath, 0o755);

    applyPrepareCommitMsgInstall(planPrepareCommitMsgInstall({ repoRoot: tmp }));
    expect(fs.readFileSync(hookPath + '.local', 'utf8')).toBe(original);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain(PREPARE_COMMIT_MSG_HEADER_MARKER);

    applyPrepareCommitMsgUninstall(planPrepareCommitMsgUninstall(tmp));
    expect(fs.existsSync(hookPath + '.local')).toBe(false);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
  });

  it('husky install appends a delimited block; uninstall removes only that block', () => {
    const huskyPath = path.join(tmp, '.husky', 'prepare-commit-msg');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    const original = '#!/bin/sh\necho existing\n';
    fs.writeFileSync(huskyPath, original);

    applyPrepareCommitMsgInstall(planPrepareCommitMsgInstall({ repoRoot: tmp }));
    const after = fs.readFileSync(huskyPath, 'utf8');
    expect(after).toContain(PREPARE_COMMIT_MSG_HUSKY_BEGIN);
    expect(after).toContain(PREPARE_COMMIT_MSG_HUSKY_END);
    expect(after).toContain('echo existing');

    applyPrepareCommitMsgUninstall(planPrepareCommitMsgUninstall(tmp));
    const restored = fs.readFileSync(huskyPath, 'utf8');
    expect(restored).not.toContain(PREPARE_COMMIT_MSG_HUSKY_BEGIN);
    expect(restored).toContain('echo existing');
  });

  it('reports not-installed when no prepare-commit-msg hook exists', () => {
    expect(planPrepareCommitMsgUninstall(tmp).mode).toBe('not-installed');
  });

  it('leaves foreign prepare-commit-msg hooks alone (not-installed)', () => {
    fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'prepare-commit-msg'), '#!/bin/sh\necho foreign\n');
    expect(planPrepareCommitMsgUninstall(tmp).mode).toBe('not-installed');
  });
});

describe('stripPrepareCommitMsgHuskyBlock', () => {
  it('removes only the tenbo block, preserving surrounding lines', () => {
    const input = `line one\n\n${PREPARE_COMMIT_MSG_HUSKY_BEGIN}\necho tenbo\n${PREPARE_COMMIT_MSG_HUSKY_END}\nline two\n`;
    const out = stripPrepareCommitMsgHuskyBlock(input);
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).not.toContain('echo tenbo');
    expect(out).not.toContain(PREPARE_COMMIT_MSG_HUSKY_BEGIN);
  });
});

describe('prepare-commit-msg hook body execution (fail-open, never blocks commit)', () => {
  let repoRoot: string;
  let binDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tenbo-prepare-msg-exec-'));
    fs.mkdirSync(path.join(repoRoot, '.tenbo'), { recursive: true });
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenbo-fake-bin-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function writeHookScript(): string {
    const hookPath = path.join(repoRoot, 'prepare-commit-msg');
    fs.writeFileSync(hookPath, PREPARE_COMMIT_MSG_HOOK_BODY);
    fs.chmodSync(hookPath, 0o755);
    return hookPath;
  }

  function fakeNpx(behavior: 'suggest' | 'empty' | 'fail' | 'hang' | 'trap-hang') {
    const npxPath = path.join(binDir, 'npx');
    let body = '#!/usr/bin/env sh\n';
    if (behavior === 'suggest') {
      body += 'echo "# tenbo commit-context suggestion (td-025):"\necho "# Advances td-025: Commit-context command"\nexit 0\n';
    } else if (behavior === 'empty') {
      body += 'exit 0\n';
    } else if (behavior === 'fail') {
      body += 'exit 1\n';
    } else if (behavior === 'trap-hang') {
      // Ignores SIGTERM entirely — only SIGKILL can stop it. Reproduces the
      // reviewer's 31s hang against the intended 5s budget.
      body += "trap '' TERM\nsleep 30\n";
    } else {
      body += 'sleep 30\n';
    }
    fs.writeFileSync(npxPath, body);
    fs.chmodSync(npxPath, 0o755);
  }

  function runHook(hookPath: string, msgFile: string, source = '') {
    return spawnSync('sh', [hookPath, msgFile, source], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  it('prepends the suggestion to the commit message and exits 0', () => {
    fakeNpx('suggest');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const result = runHook(hookPath, msgFile);

    expect(result.status).toBe(0);
    const finalMsg = fs.readFileSync(msgFile, 'utf8');
    expect(finalMsg).toContain('original message');
    expect(finalMsg).toContain('Advances td-025: Commit-context command');
  });

  it('leaves the commit message untouched and exits 0 when there is no suggestion', () => {
    fakeNpx('empty');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const result = runHook(hookPath, msgFile);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('original message\n');
  });

  it('is fail-open: still exits 0 and leaves the message untouched if the suggestion command fails', () => {
    fakeNpx('fail');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const result = runHook(hookPath, msgFile);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('original message\n');
  });

  it('never touches -m/template/merge commits (non-empty COMMIT_SOURCE)', () => {
    fakeNpx('suggest');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'explicit -m message\n');

    const result = runHook(hookPath, msgFile, 'message');

    expect(result.status).toBe(0);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('explicit -m message\n');
  });

  it('no-ops silently when .tenbo/ is absent', () => {
    fs.rmSync(path.join(repoRoot, '.tenbo'), { recursive: true, force: true });
    fakeNpx('suggest');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const result = runHook(hookPath, msgFile);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('original message\n');
  });

  it('is time-budgeted: a hanging suggestion command does not hang the hook and never blocks the commit', () => {
    fakeNpx('hang');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const start = Date.now();
    const result = runHook(hookPath, msgFile);
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('original message\n');
  }, 15_000);

  it('escalates to SIGKILL when the suggestion command ignores SIGTERM (BLOCKER regression)', () => {
    fakeNpx('trap-hang');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const start = Date.now();
    const result = runHook(hookPath, msgFile);
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe(0);
    // TERM fires at ~5s, KILL fires at ~6s. A working escalation returns
    // well under the 30s the child would otherwise sleep for; a TERM-only
    // watcher (the pre-fix bug) leaves the hook hanging until ~30s.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(fs.readFileSync(msgFile, 'utf8')).toBe('original message\n');
  }, 15_000);

  it('prepends the suggestion above the original message content (order, not just presence)', () => {
    fakeNpx('suggest');
    const hookPath = writeHookScript();
    const msgFile = path.join(repoRoot, 'COMMIT_EDITMSG');
    fs.writeFileSync(msgFile, 'original message\n');

    const result = runHook(hookPath, msgFile);

    expect(result.status).toBe(0);
    const finalMsg = fs.readFileSync(msgFile, 'utf8');
    const suggestionIndex = finalMsg.indexOf('Advances td-025: Commit-context command');
    const originalIndex = finalMsg.indexOf('original message');
    expect(suggestionIndex).toBeGreaterThanOrEqual(0);
    expect(originalIndex).toBeGreaterThanOrEqual(0);
    expect(suggestionIndex).toBeLessThan(originalIndex);
  });
});

describe('planPostCommitInstall (td-028, opt-in, independent of pre-commit and prepare-commit-msg)', () => {
  it('plans a standalone install when no post-commit hook exists', () => {
    const plan = planPostCommitInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('standalone');
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0].path).toBe(path.join(tmp, '.git', 'hooks', 'post-commit'));
  });

  it('does not consider an installed pre-commit hook as post-commit being installed', () => {
    applyInstall(planInstall({ repoRoot: tmp }));
    const plan = planPostCommitInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('standalone');
  });

  it('detects an already-installed tenbo post-commit hook (header present)', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, `#!/usr/bin/env sh\n${POST_COMMIT_HEADER_MARKER}\necho hi\n`);
    const plan = planPostCommitInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('already-installed');
  });

  it('chains a foreign post-commit hook by moving it aside to .local', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'post-commit');
    fs.writeFileSync(hookPath, '#!/bin/sh\necho foreign\n');
    const plan = planPostCommitInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('chained');
    expect(plan.moves[0].to.endsWith('.local')).toBe(true);
  });

  it('prefers husky integration when .husky/post-commit exists', () => {
    const huskyPath = path.join(tmp, '.husky', 'post-commit');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    fs.writeFileSync(huskyPath, '#!/bin/sh\necho existing\n');
    const plan = planPostCommitInstall({ repoRoot: tmp });
    expect(plan.mode).toBe('husky');
    expect(plan.writes[0].path).toBe(huskyPath);
  });

  it('standalone install creates an executable hook with the tenbo header', () => {
    const plan = planPostCommitInstall({ repoRoot: tmp });
    applyPostCommitInstall(plan);
    const hookPath = path.join(tmp, '.git', 'hooks', 'post-commit');
    const body = fs.readFileSync(hookPath, 'utf8');
    expect(body).toBe(POST_COMMIT_HOOK_BODY);
    expect(body).toContain(POST_COMMIT_HEADER_MARKER);
    expect(body).toContain('exit 0');
    expect(body).toContain('reconcile flag --since HEAD~1');
    expect((fs.statSync(hookPath).mode & 0o111) !== 0).toBe(true);
  });

  it('chained install preserves the foreign hook at .local and restores on uninstall', () => {
    const hookPath = path.join(tmp, '.git', 'hooks', 'post-commit');
    const original = '#!/bin/sh\necho foreign-hook\n';
    fs.writeFileSync(hookPath, original);
    fs.chmodSync(hookPath, 0o755);

    applyPostCommitInstall(planPostCommitInstall({ repoRoot: tmp }));
    expect(fs.readFileSync(hookPath + '.local', 'utf8')).toBe(original);
    expect(fs.readFileSync(hookPath, 'utf8')).toContain(POST_COMMIT_HEADER_MARKER);

    applyPostCommitUninstall(planPostCommitUninstall(tmp));
    expect(fs.existsSync(hookPath + '.local')).toBe(false);
    expect(fs.readFileSync(hookPath, 'utf8')).toBe(original);
  });

  it('husky install appends a delimited block; uninstall removes only that block', () => {
    const huskyPath = path.join(tmp, '.husky', 'post-commit');
    fs.mkdirSync(path.dirname(huskyPath), { recursive: true });
    const original = '#!/bin/sh\necho existing\n';
    fs.writeFileSync(huskyPath, original);

    applyPostCommitInstall(planPostCommitInstall({ repoRoot: tmp }));
    const after = fs.readFileSync(huskyPath, 'utf8');
    expect(after).toContain(POST_COMMIT_HUSKY_BEGIN);
    expect(after).toContain(POST_COMMIT_HUSKY_END);
    expect(after).toContain('echo existing');

    applyPostCommitUninstall(planPostCommitUninstall(tmp));
    const restored = fs.readFileSync(huskyPath, 'utf8');
    expect(restored).not.toContain(POST_COMMIT_HUSKY_BEGIN);
    expect(restored).toContain('echo existing');
  });

  it('reports not-installed when no post-commit hook exists', () => {
    expect(planPostCommitUninstall(tmp).mode).toBe('not-installed');
  });

  it('leaves foreign post-commit hooks alone (not-installed)', () => {
    fs.writeFileSync(path.join(tmp, '.git', 'hooks', 'post-commit'), '#!/bin/sh\necho foreign\n');
    expect(planPostCommitUninstall(tmp).mode).toBe('not-installed');
  });
});

describe('stripPostCommitHuskyBlock', () => {
  it('removes only the tenbo block, preserving surrounding lines', () => {
    const input = `line one\n\n${POST_COMMIT_HUSKY_BEGIN}\necho tenbo\n${POST_COMMIT_HUSKY_END}\nline two\n`;
    const out = stripPostCommitHuskyBlock(input);
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).not.toContain('echo tenbo');
    expect(out).not.toContain(POST_COMMIT_HUSKY_BEGIN);
  });
});

describe('post-commit hook body execution (fail-open, never blocks, never hangs)', () => {
  let repoRoot: string;
  let binDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tenbo-post-commit-exec-'));
    fs.mkdirSync(path.join(repoRoot, '.tenbo'), { recursive: true });
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenbo-fake-bin-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  function writeHookScript(): string {
    const hookPath = path.join(repoRoot, 'post-commit');
    fs.writeFileSync(hookPath, POST_COMMIT_HOOK_BODY);
    fs.chmodSync(hookPath, 0o755);
    return hookPath;
  }

  function fakeNpx(behavior: 'ok' | 'fail' | 'hang' | 'trap-hang', logPath?: string) {
    const npxPath = path.join(binDir, 'npx');
    let body = '#!/usr/bin/env sh\n';
    if (behavior === 'ok') {
      body += logPath ? `echo "called: $*" >> "${logPath}"\n` : '';
      body += 'exit 0\n';
    } else if (behavior === 'fail') {
      body += 'exit 1\n';
    } else if (behavior === 'trap-hang') {
      // Ignores SIGTERM entirely — only SIGKILL can stop it.
      body += "trap '' TERM\nsleep 30\n";
    } else {
      body += 'sleep 30\n';
    }
    fs.writeFileSync(npxPath, body);
    fs.chmodSync(npxPath, 0o755);
  }

  function runHook(hookPath: string) {
    return spawnSync('sh', [hookPath], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: 'utf8',
      timeout: 15_000,
    });
  }

  it('calls reconcile flag --since HEAD~1 and exits 0', () => {
    const logPath = path.join(repoRoot, 'calls.log');
    fakeNpx('ok', logPath);
    const hookPath = writeHookScript();

    const result = runHook(hookPath);

    expect(result.status).toBe(0);
    expect(fs.readFileSync(logPath, 'utf8')).toContain('reconcile flag --since HEAD~1');
  });

  it('is fail-open: still exits 0 if the reconcile command fails', () => {
    fakeNpx('fail');
    const hookPath = writeHookScript();

    const result = runHook(hookPath);

    expect(result.status).toBe(0);
  });

  it('no-ops silently (exit 0, no call) when .tenbo/ is absent', () => {
    fs.rmSync(path.join(repoRoot, '.tenbo'), { recursive: true, force: true });
    const logPath = path.join(repoRoot, 'calls.log');
    fakeNpx('ok', logPath);
    const hookPath = writeHookScript();

    const result = runHook(hookPath);

    expect(result.status).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('is time-budgeted: a hanging reconcile command does not hang the hook', () => {
    fakeNpx('hang');
    const hookPath = writeHookScript();

    const start = Date.now();
    const result = runHook(hookPath);
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it('escalates to SIGKILL when the reconcile command ignores SIGTERM', () => {
    fakeNpx('trap-hang');
    const hookPath = writeHookScript();

    const start = Date.now();
    const result = runHook(hookPath);
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe(0);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);
});
