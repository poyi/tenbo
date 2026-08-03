import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalTenboBackend } from './LocalTenboBackend';
import { TENBO_SCHEMA_VERSION, type TenboCommand } from '../../contracts/tenbo';

let repoRoot: string;
let mutation = 0;

beforeEach(() => {
  mutation = 0;
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tenbo-local-backend-'));
  mkdirSync(path.join(repoRoot, '.git'));
  mkdirSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app'), { recursive: true });
  writeFileSync(path.join(repoRoot, '.tenbo/workspace.yaml'), [
    'scopes:',
    '  - id: editor',
    '    prefix: ed',
    '    path: apps/editor',
    '    description: editor',
    'cross_cutting: []',
    '',
  ].join('\n'));
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/architecture.yaml'), [
    'layers:',
    '  - id: app',
    '    name: App',
    '    description: app layer',
    '    files: ["src/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app/README.md'), '# App\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/layers/app/intent.md'), '# App intent\n\n## Invariants\n\n- Keep commands typed.\n');
  writeFileSync(path.join(repoRoot, '.tenbo/overview.md'), '# Overview\n\n## Product goals\n- **g1**: Typed planning.\n');
  writeFileSync(path.join(repoRoot, '.tenbo/principles.md'), '# Principles\n');
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: First',
    '    layer: app',
    '    status: next',
    '    description: first',
    '  - id: ed-002',
    '    title: Second',
    '    layer: app',
    '    status: later',
    '    description: second',
    '',
  ].join('\n'));
  writeFileSync(path.join(repoRoot, '.tenbo/scopes/editor/roadmap-archive.yaml'), [
    'items:',
    '  - id: ed-099',
    '    title: Historical',
    '    layer: app',
    '    status: done',
    '    description: archived high-water mark',
    '',
  ].join('\n'));
});

afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

function envelope(command: TenboCommand, mutationId = `typed-${++mutation}`) {
  return {
    schema_version: TENBO_SCHEMA_VERSION,
    mutation_id: mutationId,
    actor: { id: 'test-agent', type: 'agent' as const },
    command,
  };
}

describe('LocalTenboBackend typed command coverage', () => {
  it('executes every roadmap, coordination, and planning-document mutation without direct file edits', async () => {
    const backend = new LocalTenboBackend(repoRoot);

    const allocationRequest = envelope({ kind: 'allocateItemId', prefix: 'ed' }, 'allocate-once');
    const allocated = await backend.command(allocationRequest);
    expect(allocated).toEqual({ kind: 'allocation', item_id: 'ed-100' });
    expect(await backend.command(allocationRequest)).toEqual(allocated);

    const created = await backend.command(envelope({
      kind: 'createItem',
      scope_id: 'editor',
      item: { id: 'ed-100', title: 'Cloud seam', description: 'Exercise typed commands.', status: 'later', layer: 'app' },
    }));
    expect(created.kind).toBe('item');

    const updated = await backend.command(envelope({
      kind: 'updateRichFields',
      item_id: 'ed-100',
      patch: { priority: 'p1', done_when: ['Every command works.'], risks: ['Keep local compatibility.'] },
    }));
    expect(updated.kind === 'item' && updated.value.item.priority).toBe('p1');

    await backend.command(envelope({ kind: 'setStatus', item_id: 'ed-100', status: 'now' }));
    const reordered = await backend.command(envelope({ kind: 'reorderItems', scope_id: 'editor', item_ids: ['ed-100', 'ed-001', 'ed-002'] }));
    expect(reordered).toMatchObject({ kind: 'reorder', item_ids: ['ed-100', 'ed-001', 'ed-002'] });

    const noted = await backend.command(envelope({ kind: 'addNote', item_id: 'ed-100', note: 'Typed note.' }));
    expect(noted.kind === 'item' && noted.value.item.notes).toContain('[test-agent]: Typed note.');
    await backend.command(envelope({ kind: 'setVerification', item_id: 'ed-100', status: 'pending_live', evidence: ['targeted test'] }));
    await backend.command(envelope({ kind: 'setDocUpdate', item_id: 'ed-100', doc_update: '2026-08-02' }));
    await backend.command(envelope({ kind: 'linkCommit', item_id: 'ed-100', commit: 'abc123' }));

    const claim = await backend.command(envelope({ kind: 'claimItem', item_id: 'ed-100', owner: 'test-agent', lease_seconds: 60 }));
    expect(claim.kind).toBe('claim');
    if (claim.kind !== 'claim') throw new Error('claim result expected');
    const renewed = await backend.command(envelope({
      kind: 'renewClaim', item_id: 'ed-100', owner: 'test-agent', fencing_token: claim.value.fencing_token, lease_seconds: 120,
    }));
    expect(renewed.kind === 'claim' && renewed.value.version).toBe(2);
    await backend.command(envelope({
      kind: 'releaseClaim', item_id: 'ed-100', owner: 'test-agent', fencing_token: claim.value.fencing_token,
    }));

    const workpad = await backend.command(envelope({
      kind: 'createPlanningDocument', item_id: 'ed-100', document_kind: 'workpad', content: '# Workpad\n\n## Plan\n\n- [ ] finish\n',
    }));
    expect(workpad.kind === 'document' && workpad.value.path).toBe('.tenbo/workpads/ed-100.md');
    if (workpad.kind !== 'document') throw new Error('document result expected');
    const revised = await backend.command(envelope({
      kind: 'updatePlanningDocument', document_id: workpad.value.id, content: '# Workpad\n\n## Plan\n\n- [x] finish\n', expected_version: workpad.value.version,
    }));
    expect(revised.kind).toBe('document');
    if (revised.kind !== 'document') throw new Error('document result expected');
    const archivedDocument = await backend.command(envelope({
      kind: 'archivePlanningDocument', document_id: revised.value.id, expected_version: revised.value.version,
    }));
    expect(archivedDocument.kind === 'document' && archivedDocument.value.archived).toBe(true);
    if (archivedDocument.kind !== 'document') throw new Error('document result expected');
    const restoredDocument = await backend.command(envelope({ kind: 'restorePlanningDocument', document_id: archivedDocument.value.id }));
    expect(restoredDocument.kind === 'document' && restoredDocument.value.archived).toBe(false);

    const completed = await backend.command(envelope({
      kind: 'completeItem', item_id: 'ed-100', evidence: ['npm test -- --run'], doc_update: '2026-08-02', verification_status: 'verified',
    }));
    expect(completed.kind === 'item' && completed.value.item.status).toBe('done');

    const archivedItem = await backend.command(envelope({ kind: 'archiveItem', item_id: 'ed-100' }));
    expect(archivedItem.kind === 'item' && archivedItem.value.archived).toBe(true);
    const reopened = await backend.command(envelope({ kind: 'reopenItem', item_id: 'ed-100', status: 'next' }));
    expect(reopened.kind === 'item' && reopened.value.item.status).toBe('next');

    const active = readFileSync(path.join(repoRoot, '.tenbo/scopes/editor/roadmap.yaml'), 'utf8');
    expect(active).toContain('id: ed-100');
    expect(active).toContain('status: next');
  });

  it('rejects stale item versions and mutation-id reuse with a different request', async () => {
    const backend = new LocalTenboBackend(repoRoot);
    const item = await backend.query({ schema_version: TENBO_SCHEMA_VERSION, query: { kind: 'getItem', item_id: 'ed-001' } });
    if (item.kind !== 'item') throw new Error('item result expected');
    await backend.command(envelope({ kind: 'setStatus', item_id: 'ed-001', status: 'now', expected_version: item.value.version }, 'versioned'));
    await expect(backend.command(envelope({ kind: 'setStatus', item_id: 'ed-001', status: 'later', expected_version: item.value.version }, 'stale')))
      .rejects.toThrow(/changed since it was read/);
    await expect(backend.command(envelope({ kind: 'setStatus', item_id: 'ed-002', status: 'now' }, 'versioned')))
      .rejects.toThrow(/reused with a different request/);
  });
});
