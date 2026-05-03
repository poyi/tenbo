import { describe, it, expect } from 'vitest';
import { analyzeAgingTodos, parseTodoLines } from './agingTodos';
import { DEFAULT_HEALTH_CONFIG } from './config';

describe('parseTodoLines', () => {
  it('extracts TODO and FIXME with line numbers', () => {
    const src = [
      'function foo() {',
      '  // TODO: fix this',
      '  /* FIXME(poyi): broken */',
      '  return 1;',
      '}',
    ].join('\n');
    const matches = parseTodoLines(src);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({ line: 2, text: 'TODO: fix this' });
    expect(matches[1].line).toBe(3);
  });

  it('ignores TODO inside string literals', () => {
    const src = `const s = "TODO this is a string";`;
    expect(parseTodoLines(src)).toEqual([]);
  });
});

describe('analyzeAgingTodos', () => {
  // Smoke test: just ensure it returns an array on real-repo files without throwing.
  it('does not throw on real files', () => {
    const findings = analyzeAgingTodos(process.cwd(), 'lyr', [], DEFAULT_HEALTH_CONFIG);
    expect(Array.isArray(findings)).toBe(true);
  });
});
