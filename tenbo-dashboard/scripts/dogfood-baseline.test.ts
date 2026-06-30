import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../src/api/lib/repoRoot';
import { resolveFeatureContext } from '../src/api/lib/contextResolver';
import { resolveImpact } from '../src/api/lib/impact';
import { runIndexCli } from './index';

function repoRoot(): string {
  const root = findRepoRoot(process.cwd());
  if (!root) throw new Error('Could not find repo root');
  return root;
}

describe('td-023 dogfood baseline', () => {
  function buildIndex() {
    const result = runIndexCli(repoRoot(), ['--json']);
    expect(result.exitCode).toBe(0);
  }

  it('routes dashboard CLI impact work to dashboard cli-tools', () => {
    buildIndex();
    const bundle = resolveFeatureContext(repoRoot(), 'dashboard CLI command impact', {
      now: new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(bundle.recommendation.scope).toBe('dashboard');
    expect(bundle.recommendation.layers[0]).toBe('cli-tools');
    expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
    expect(bundle.context.read_plan.some((entry) => entry.kind === 'source-file')).toBe(true);
  });

  it('routes dashboard health graph work to dashboard data-layer', () => {
    buildIndex();
    const bundle = resolveFeatureContext(repoRoot(), 'dashboard data-layer health structural graph dead code coupling', {
      now: new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(bundle.recommendation.scope).toBe('dashboard');
    expect(bundle.recommendation.layers[0]).toBe('data-layer');
    expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
    expect(bundle.context.read_plan.some((entry) => entry.kind === 'source-file')).toBe(true);
  });

  it('keeps impact related items bounded by default', () => {
    const impact = resolveImpact(repoRoot());

    expect(impact.related_items.length).toBeLessThanOrEqual(8);
    expect(impact.stale_docs.length).toBeGreaterThan(0);
  });
});
