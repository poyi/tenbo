import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFeatureContext } from './contextResolver';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tenbo-context-resolver-'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/scopes/dashboard/layers/data-layer'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/scopes/skill/layers/core-logic'), { recursive: true });
  mkdirSync(path.join(dir, '.tenbo/scopes/skill/layers/templates'), { recursive: true });

  writeFileSync(path.join(dir, '.tenbo/workspace.yaml'), [
    'scopes:',
    '  - id: dashboard',
    '    path: tenbo-dashboard',
    '    description: dashboard and CLI package',
    '  - id: skill',
    '    path: skill',
    '    description: installed agent skill behavior',
    'cross_cutting: []',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/overview.md'), [
    '# Overview',
    '',
    '## Product goals',
    '',
    '- **g1**: Give agents holistic, persistent context about the project across sessions.',
    '- **g2**: Maintain modularity and scalability as the codebase grows.',
    '- **g3**: Spot refactor opportunities proactively.',
    '',
    '## Non-goals',
    '',
    '- Not a human-only project tracker.',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/agent-context.md'), '# Agent Context\nOld context\n');
  utimesSync(path.join(dir, '.tenbo/agent-context.md'), new Date('2026-05-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z'));

  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/architecture.yaml'), [
    'layers:',
    '  - id: data-layer',
    '    name: Data Layer',
    '    description: Reads workspace data and prepares agent context bundles.',
    '    files: ["src/api/**", "src/types.ts"]',
    '  - id: cli-tools',
    '    name: CLI Tools',
    '    description: Command-line helpers for validation, item queries, and context fetching.',
    '    files: ["bin/**", "scripts/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/cli-tools/intent.md'), [
    '# CLI Tools',
    '',
    'Optimizing-for: typed commands that let agents fetch context without hand-reading YAML.',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/layers/data-layer/intent.md'), [
    '# Data Layer',
    '',
    'Optimizing-for: deterministic readers over tenbo state and roadmap data.',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/dashboard/roadmap.yaml'), [
    'items:',
    '  - id: td-010',
    '    title: Add context resolver CLI',
    '    layer: cli-tools',
    '    status: next',
    '    goal_ref: [g1]',
    '    description: Let agents fetch feature-planning context in one command.',
    '    notes: long implementation history that should not be included in context bundles',
    '    risks:',
    '      - long risk history that should stay out of matching item summaries',
    '    files_to_read:',
    '      - tenbo-dashboard/scripts/context.ts',
    '      - tenbo-dashboard/src/api/lib/contextResolver.ts',
    '',
  ].join('\n'));

  writeFileSync(path.join(dir, '.tenbo/scopes/skill/architecture.yaml'), [
    'layers:',
    '  - id: core-logic',
    '    name: Core Logic',
    '    description: The skill decides how to react when users ask agents to build features.',
    '    files: ["SKILL.md", "VERSION"]',
    '  - id: templates',
    '    name: Templates',
    '    description: Starter files with automatic context fetching feature request examples.',
    '    files: ["templates/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/skill/layers/core-logic/intent.md'), [
    '# Core Logic',
    '',
    'Optimizing-for: passive context fetching before planning normal feature requests.',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/skill/layers/templates/intent.md'), [
    '# Templates',
    '',
    'Examples for automatic context fetching feature requests.',
    '',
  ].join('\n'));
  writeFileSync(path.join(dir, '.tenbo/scopes/skill/roadmap.yaml'), [
    'items:',
    '  - id: sk-030',
    '    title: Load context automatically for feature work',
    '    layer: core-logic',
    '    status: now',
    '    goal_ref: [g1]',
    '    description: Update the skill so agents fetch project context for build requests.',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('contextResolver', () => {
  it('resolves feature requests into an agent-ready planning bundle', () => {
    const bundle = resolveFeatureContext(dir, 'help me build automatic context fetching for feature requests', {
      now: new Date('2026-06-14T12:00:00.000Z'),
    });

    expect(bundle).toMatchObject({
      ok: true,
      intent: 'feature',
      query: 'help me build automatic context fetching for feature requests',
      recommendation: {
        confidence: 'high',
        scope: 'skill',
        layers: ['core-logic'],
        goal_refs: ['g1'],
      },
    });
    expect(bundle.roadmap.active_items.map((entry) => entry.item.id)).toEqual(['sk-030']);
    expect(bundle.roadmap.matching_items.map((entry) => entry.item.id)).toContain('td-010');
    expect(bundle.roadmap.matching_items.find((entry) => entry.item.id === 'td-010')?.item).not.toHaveProperty('notes');
    expect(bundle.roadmap.matching_items.find((entry) => entry.item.id === 'td-010')?.item).not.toHaveProperty('risks');
    expect(bundle.context.layer_docs).toContain('.tenbo/scopes/skill/layers/core-logic/intent.md');
    expect(bundle.context.files_to_read).toContain('SKILL.md');
    expect(bundle.warnings).toContainEqual(expect.objectContaining({ kind: 'stale_agent_context' }));
  });

  it('returns candidates instead of overclaiming when a query has low overlap', () => {
    const bundle = resolveFeatureContext(dir, 'improve billing invoices', {
      now: new Date('2026-06-14T12:00:00.000Z'),
    });

    expect(bundle.recommendation.confidence).toBe('low');
    expect(bundle.recommendation.scope).toBeNull();
    expect(bundle.candidates.scopes.map((entry) => entry.id)).toContain('dashboard');
  });
});
