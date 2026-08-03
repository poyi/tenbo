import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalTenboBackend } from './LocalTenboBackend';
import { TENBO_SCHEMA_VERSION } from '../../contracts/tenbo';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tenbo-bounded-backend-'));
  mkdirSync(path.join(repoRoot, '.git'));
  mkdirSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/unrelated/README.md'), { recursive: true });
  mkdirSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/unrelated/intent.md'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.tenbo/workspace.yaml'), 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor\ncross_cutting: []\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/architecture.yaml'), [
    'layers:',
    '  - id: app',
    '    name: App',
    '    description: bounded cloud roadmap commands',
    '    files: ["src/app/**"]',
    '  - id: unrelated',
    '    name: Unrelated',
    '    description: should never be opened',
    '    files: ["src/unrelated/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app/intent.md'), '# App\n\n## Invariants\n\n- Stay bounded.\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app/code-map.md'), '# Code map\n');
  writeFileSync(path.join(repoRoot, '.tenbo/overview.md'), '# Overview\n\n## Product goals\n- **g1**: Keep cloud roadmap context bounded.\n');
  writeFileSync(path.join(repoRoot, '.tenbo/principles.md'), '# Principles\n');
  const long = 'cloud roadmap '.repeat(200);
  const items = Array.from({ length: 40 }, (_, index) => [
    `  - id: ed-${String(index + 1).padStart(3, '0')}`,
    `    title: Cloud roadmap item ${index + 1}`,
    '    layer: app',
    `    status: ${index < 20 ? 'now' : 'next'}`,
    `    description: "${long}"`,
    '    done_when:',
    `      - "${long}"`,
  ].join('\n')).join('\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/roadmap.yaml'), `items:\n${items}\n`);
  // These are deliberately invalid/unreadable as files. Any eager archive or
  // unrelated narrative read would throw and fail the test.
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/roadmap-archive.yaml'), 'items: [unterminated\n');
});

afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('LocalTenboBackend bounded lightweight reads', () => {
  it('lists and resolves item/session/feature context without archives or unrelated narratives', async () => {
    const backend = new LocalTenboBackend(repoRoot);
    const list = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'listItems', page: { limit: 5 } } });
    expect(list.kind === 'itemPage' && list.value.items).toHaveLength(5);
    expect(list.kind === 'itemPage' && list.value.page.has_more).toBe(true);

    const item = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'getItem', item_id: 'ed-001' } });
    expect(item.kind === 'item' && item.value.item.id).toBe('ed-001');

    const session = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'getSessionContext' } });
    const feature = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'searchContext', query: 'cloud roadmap commands' } });
    const itemContext = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'getItemContext', item_id: 'ed-001' } });
    for (const result of [session, feature, itemContext]) {
      expect(result.kind).toBe('context');
      if (result.kind !== 'context') continue;
      expect(result.bounds.row_count).toBeLessThanOrEqual(result.bounds.limits.rows);
      expect(result.bounds.byte_count).toBeLessThanOrEqual(result.bounds.limits.bytes);
      expect(result.bounds.token_estimate).toBeLessThanOrEqual(result.bounds.limits.tokens);
    }
  });
});
