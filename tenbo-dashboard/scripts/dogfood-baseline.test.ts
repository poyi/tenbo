import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveFeatureContext } from '../src/api/lib/contextResolver';
import { resolveImpact } from '../src/api/lib/impact';
import { runIndexCli } from './index';

let dir: string;

function write(rel: string, content: string) {
  const full = path.join(dir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-representative-dashboard-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  write('.tenbo/workspace.yaml', 'scopes:\n  - id: dashboard\n    path: tenbo-dashboard\n    description: dashboard and CLI package\ncross_cutting: []\n');
  write('.tenbo/overview.md', '# Product goals\nGive agents bounded context for dashboard and CLI work.\n');
  const layers = [
    { id: 'cli-tools', name: 'CLI Tools', description: 'Dashboard CLI commands for impact and context', files: ['scripts/**'] },
    { id: 'data-layer', name: 'Data Layer', description: 'Dashboard health structural graph, dead code and coupling analysis', files: ['src/api/**'] },
    { id: 'ui', name: 'Dashboard UI', description: 'Dashboard presentation, screens and navigation', files: ['src/ui/**'] },
  ];
  // JSON is a YAML subset, and keeps this synthetic fixture's structure explicit.
  write('.tenbo/scopes/dashboard/architecture.yaml', JSON.stringify({ layers }));
  for (const layer of layers) {
    write(`.tenbo/scopes/dashboard/layers/${layer.id}/intent.md`, `# ${layer.name}\n${layer.description}\n`);
    write(`.tenbo/scopes/dashboard/layers/${layer.id}/code-map.md`, `# ${layer.name}\nCommitted source map; CLI exports runImpact.\n`);
  }
  // More candidates than the default cap: an empty roadmap would make the
  // related-items bound vacuous, just as two layers would trivialize top-2.
  write('.tenbo/scopes/dashboard/roadmap.yaml', JSON.stringify({ items: Array.from({ length: 10 }, (_, index) => ({
    id: `td-${index + 1}`,
    title: `CLI command impact follow-up ${index + 1}`,
    description: 'Dashboard CLI command impact work',
    layer: 'cli-tools',
    status: 'now',
  })) }));
  write('tenbo-dashboard/tsconfig.json', JSON.stringify({ compilerOptions: { module: 'esnext', target: 'es2020' }, include: ['src', 'scripts'] }));
  write('tenbo-dashboard/src/api/structuralGraph.ts', 'export function buildStructuralGraph() { return { health: "dead code coupling" }; }\n');
  write('tenbo-dashboard/src/ui/dashboard.ts', 'export const dashboardScreen = "navigation and presentation";\n');
  write('tenbo-dashboard/scripts/impact.ts', 'export function runImpact() { return "CLI impact"; }\n');
  git('add', '.');
  git('commit', '-m', 'representative dashboard fixture');
  // A real source change leaves the committed map without this new symbol.
  write('tenbo-dashboard/scripts/impact.ts', 'export function runImpact() { return "CLI impact"; }\nexport const newImpactCommand = true;\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('td-023 representative dashboard workspace baseline', () => {
  function buildIndex() {
    const result = runIndexCli(dir, ['--json']);
    expect(result.exitCode).toBe(0);
  }

  it('routes dashboard CLI impact work toward the dashboard cli-tools layer', () => {
    buildIndex();
    const bundle = resolveFeatureContext(dir, 'dashboard CLI command impact', {
      now: new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(bundle.recommendation.scope).toBe('dashboard');
    // Retain the original top-2 contract, with three meaningful competitors.
    expect(bundle.candidates.layers.length).toBeGreaterThanOrEqual(3);
    const cliToolsRank = bundle.candidates.layers.findIndex((entry) => entry.id === 'cli-tools');
    expect(cliToolsRank).toBeGreaterThanOrEqual(0);
    expect(cliToolsRank).toBeLessThan(2);
    expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
    expect(bundle.context.read_plan.some((entry) => entry.kind === 'source-file')).toBe(true);
  });

  it('routes dashboard health graph work to dashboard data-layer', () => {
    buildIndex();
    const bundle = resolveFeatureContext(dir, 'dashboard data-layer health structural graph dead code coupling', {
      now: new Date('2026-06-30T00:00:00.000Z'),
    });

    expect(bundle.recommendation.scope).toBe('dashboard');
    expect(bundle.recommendation.layers[0]).toBe('data-layer');
    expect(bundle.context.read_plan.length).toBeLessThanOrEqual(12);
    expect(bundle.context.read_plan.some((entry) => entry.kind === 'source-file')).toBe(true);
  });

  it('keeps impact related items bounded by default', () => {
    const impact = resolveImpact(dir);

    expect(impact.related_items.length).toBeLessThanOrEqual(8);
    expect(impact.related_items).toHaveLength(8);
    expect(impact.stale_docs.length).toBeGreaterThan(0);
    expect(impact.changed_files).toContain('tenbo-dashboard/scripts/impact.ts');
    expect(impact.stale_docs).toContain('.tenbo/scopes/dashboard/layers/cli-tools/code-map.md');
  });
});
