import { describe, it, expect } from 'vitest';
import { computeDiff, renderOutput, issueKey } from './validate-cli';
import type { ValidateIssue } from '../src/types';

const warn = (msg: string, scope = 'editor', itemId?: string): ValidateIssue => ({
  level: 'warning',
  message: msg,
  scope,
  itemId,
});
const err = (msg: string, scope = 'editor', itemId?: string): ValidateIssue => ({
  level: 'error',
  message: msg,
  scope,
  itemId,
});

const snap = (errors: ValidateIssue[] = [], warnings: ValidateIssue[] = []) => ({
  generated_at: '2026-04-28T00:00:00Z',
  errors,
  warnings,
});

describe('issueKey', () => {
  it('hashes message + scope + itemId/layerId stably', () => {
    const a = warn('x', 'editor', 'ed-001');
    const b = warn('x', 'editor', 'ed-001');
    expect(issueKey(a)).toBe(issueKey(b));
  });
  it('distinguishes different itemIds with the same message', () => {
    expect(issueKey(warn('x', 'editor', 'ed-001'))).not.toBe(issueKey(warn('x', 'editor', 'ed-002')));
  });
});

describe('computeDiff', () => {
  it('treats every finding as new when there is no previous snapshot', () => {
    const cur = snap([], [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')]);
    const d = computeDiff(null, cur);
    expect(d.newWarnings).toHaveLength(2);
    expect(d.preExistingWarnings).toHaveLength(0);
  });

  it('treats identical findings as pre-existing', () => {
    const w = [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')];
    const d = computeDiff(snap([], w), snap([], w));
    expect(d.newWarnings).toHaveLength(0);
    expect(d.preExistingWarnings).toHaveLength(2);
  });

  it('isolates one new warning against an otherwise-identical prior run', () => {
    const prevW = [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')];
    const newW = [...prevW, warn('c', 'editor', 'ed-003')];
    const d = computeDiff(snap([], prevW), snap([], newW));
    expect(d.newWarnings).toHaveLength(1);
    expect(d.newWarnings[0].message).toBe('c');
    expect(d.preExistingWarnings).toHaveLength(2);
  });

  it('separates new vs pre-existing errors the same way', () => {
    const prevE = [err('e1', 'editor', 'ed-010')];
    const newE = [...prevE, err('e2', 'editor', 'ed-011')];
    const d = computeDiff(snap(prevE), snap(newE));
    expect(d.newErrors.map((e) => e.message)).toEqual(['e2']);
    expect(d.preExistingErrors.map((e) => e.message)).toEqual(['e1']);
  });
});

describe('renderOutput — default mode', () => {
  it('first run with no prev snapshot lists every finding as new', () => {
    const s = snap([], [warn('a', 'editor', 'ed-001')]);
    const d = computeDiff(null, s);
    const r = renderOutput(s, d, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 new warning');
    expect(r.stdout).toContain('a');
  });

  it('second run with identical findings emits the one-liner', () => {
    const w = [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')];
    const s = snap([], w);
    const d = computeDiff(snap([], w), s);
    const r = renderOutput(s, d, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^Tenbo validation passed \(0 errors, 2 warnings — all pre-existing\)/);
    expect(r.stderr).toBe('');
  });

  it('reports a single new warning while folding pre-existing into the summary', () => {
    const prev = [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')];
    const cur = [...prev, warn('c', 'editor', 'ed-003')];
    const s = snap([], cur);
    const d = computeDiff(snap([], prev), s);
    const r = renderOutput(s, d, {});
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 new warning');
    expect(r.stdout).toContain('c');
    expect(r.stdout).toContain('2 pre-existing warnings');
  });

  it('exits 1 and prints new errors to stderr when a new error appears', () => {
    const cur = snap([err('boom', 'editor', 'ed-001')], []);
    const d = computeDiff(null, cur);
    const r = renderOutput(cur, d, {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('1 new error');
    expect(r.stderr).toContain('boom');
  });
});

describe('renderOutput — verbose mode', () => {
  it('lists all errors and warnings regardless of diff', () => {
    const w = [warn('a', 'editor', 'ed-001'), warn('b', 'editor', 'ed-002')];
    const s = snap([], w);
    const d = computeDiff(snap([], w), s); // all pre-existing
    const r = renderOutput(s, d, { verbose: true });
    expect(r.exitCode).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain('a');
    expect(combined).toContain('b');
    expect(combined).toContain('Tenbo validation warnings (2)');
  });

  it('prints all errors with the FAILED header in verbose mode', () => {
    const errs = [err('e1', 'editor', 'ed-010'), err('e2', 'editor', 'ed-011')];
    const s = snap(errs, []);
    const d = computeDiff(null, s);
    const r = renderOutput(s, d, { verbose: true });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Tenbo validation FAILED');
    expect(r.stderr).toContain('e1');
    expect(r.stderr).toContain('e2');
  });
});

describe('renderOutput — json mode', () => {
  it('emits the snapshot as JSON to stdout', () => {
    const s = snap([], [warn('a', 'editor', 'ed-001')]);
    const d = computeDiff(null, s);
    const r = renderOutput(s, d, { json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.errors).toHaveLength(0);
  });

  it('exit code reflects errors even in JSON mode', () => {
    const s = snap([err('boom')], []);
    const d = computeDiff(null, s);
    const r = renderOutput(s, d, { json: true });
    expect(r.exitCode).toBe(1);
  });
});
