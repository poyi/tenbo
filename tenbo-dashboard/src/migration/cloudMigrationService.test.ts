import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandEnvelopeDto, JsonValue, QueryEnvelopeDto, TenboCommandResult, TenboGatewayPort, TenboQueryResult } from '../contracts/tenbo';
import { buildCloudRoadmapManifest, sha256, stableJson } from './cloudRoadmapManifest';
import {
  buildStagedImportPlan,
  cloudRoadmapImportIdentity,
  CloudMigrationService,
  compareProjection,
  compareSemanticResults,
  normalizeCloudExport,
  projectionOfManifest,
  STAGED_IMPORT_MAX_REQUEST_BYTES,
  STAGED_IMPORT_TARGET_CHUNK_BYTES,
} from './cloudMigrationService';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('cloud roadmap migration manifest', () => {
  it('is deterministic and preserves active/archive rich fields, normalized relations, docs, history, and claims', () => {
    const repo = fixtureRepo();
    const first = buildCloudRoadmapManifest(repo);
    const second = buildCloudRoadmapManifest(repo);
    expect(second).toEqual(first);
    expect(first.counts).toEqual({ items: 3, active_items: 2, archived_items: 1, relations: 2, documents: 2, mutations: 1, claims: 1 });
    expect(first.items.find((item) => item.id === 'ed-2')).toMatchObject({
      archived: true, priority: 'p1', verification: { status: 'verified', evidence: ['test'] },
      related: ['ed-1'], links: ['commit:abc'], phases: [{ id: 1, title: 'phase', status: 'done' }],
    });
    expect(first.relations).toEqual([
      { source_item_id: 'ed-2', target_item_id: 'ed-1', relation_type: 'related', metadata: {} },
      { source_item_id: 'x-1', target_item_id: 'ed-1', relation_type: 'spawned_from', metadata: {} },
    ]);
    expect(first.documents.map((document) => [document.kind, document.archived, document.item_id])).toEqual([
      ['spec', false, 'x-1'], ['workpad', true, 'ed-2'],
    ]);
    expect(first.mutations[0]).toMatchObject({ mutation_id: 'legacy-1', actor: 'worker', item_id: 'ed-2', operation: 'complete' });
    expect(first.claims[0]).toMatchObject({ item_id: 'x-1', owner: 'worker', fencing_token: 4 });

    writeFileSync(path.join(repo, '.tenbo/specs/x-1.md'), '---\ntenbo_item: x-1\n---\n# changed\n');
    expect(buildCloudRoadmapManifest(repo).canonical_hash).not.toBe(first.canonical_hash);
  });

  it('normalizes a full cloud export back to exact portable projection parity', () => {
    const manifest = buildCloudRoadmapManifest(fixtureRepo());
    const cloud = normalizeCloudExport(cloudExport(manifest));
    expect(compareProjection(projectionOfManifest(manifest), cloud)).toMatchObject({ equal: true, missing_item_ids: [], unexpected_item_ids: [], differing_item_ids: [] });
  });
});

describe('cloud migration service idempotency and recovery', () => {
  it('uses deterministic mutation IDs across retries and guarded replace for restore', async () => {
    const manifest = buildCloudRoadmapManifest(fixtureRepo());
    const exported = cloudExport(manifest) as Record<string, any>;
    exported.mutations.push({ mutation_id: 'cloud-native', request_hash: 'e'.repeat(64), actor_type: 'agent', actor_id: 'cloud-agent',
      command_name: 'setStatus', entity_id: 'x-1', created_at: '2026-02-01T00:00:00.000Z',
      request_body: { status: 'done' }, result_json: { kind: 'item' }, entity_type: 'item',
      committed_project_version: 4, committed_entity_version: 2, audit_metadata: {} });
    const gateway = new MemoryGateway(exported as JsonValue);
    const service = new CloudMigrationService(gateway, PROJECT_ID, { id: 'admin', type: 'agent' });
    const first = await service.importManifest(manifest);
    const second = await service.importManifest(manifest);
    expect(second).toEqual(first);
    expect(gateway.finalizedImports).toBe(1);
    expect((await service.compare(manifest)).equal).toBe(true);

    await service.importManifest(manifest, { replace: true });
    const cutoverBegin = [...gateway.commands].reverse()
      .find((entry) => entry.command.kind === 'beginProjectImport')!;
    expect(cutoverBegin.command).toMatchObject({ kind: 'beginProjectImport', replace: true });
    expect(cutoverBegin.mutation_id).toContain('tenbo-cutover-');
    expect(cloudRoadmapImportIdentity(PROJECT_ID, manifest.canonical_hash, true)).toEqual({
      mode: 'cutover',
      session_id: (cutoverBegin.command.kind === 'beginProjectImport' ? cutoverBegin.command.session_id : ''),
      mutation_id: `tenbo-cutover-${manifest.canonical_hash}`,
    });
    expect(gateway.finalizedImports).toBe(2);

    const recovery = await service.recoveryExport();
    expect(recovery.projection.mutations.some((mutation) => mutation.mutation_id === 'cloud-native')).toBe(true);
    expect(recovery.projection.mutations.find((mutation) => mutation.mutation_id === 'cloud-native')?.recovery_record)
      .toMatchObject({ actor_type: 'agent', actor_id: 'cloud-agent', command_name: 'setStatus', audit_metadata: {} });
    await expect(service.restore(recovery, '00000000-0000-4000-8000-000000000099')).rejects.toThrow(/exact --confirm-project/);
    await service.restore(recovery, PROJECT_ID);
    expect([...gateway.commands].reverse().find((entry) => entry.command.kind === 'beginProjectImport')?.command)
      .toMatchObject({ kind: 'beginProjectImport', replace: true });
    expect(gateway.commands.at(-1)?.command).toMatchObject({ kind: 'finalizeProjectImport' });
  });

  it('keeps a 12 MB manifest below the HTTP cap and resumes after an accepted chunk loses its response', async () => {
    const manifest = buildCloudRoadmapManifest(fixtureRepo());
    const document = manifest.documents[0]!;
    document.content = `# large\n${'"\\\n'.repeat(4_100_000)}`;
    document.content_hash = sha256(document.content);
    const { canonical_hash: _previousHash, ...core } = manifest;
    manifest.canonical_hash = sha256(stableJson(core));
    const plan = buildStagedImportPlan({
      core: core as unknown as JsonValue,
      manifestHash: manifest.canonical_hash,
      expectedCounts: manifest.counts,
      replace: false,
      finalizeMutationId: `tenbo-import-${manifest.canonical_hash}`,
      projectId: PROJECT_ID,
      actor: { id: 'admin', type: 'agent' },
    });
    expect(plan.manifest_bytes).toBeGreaterThan(12_072_329);
    expect(plan.chunks.length).toBeGreaterThan(40);
    expect(Math.max(...plan.chunks.map((chunk) => chunk.byte_count))).toBeLessThanOrEqual(STAGED_IMPORT_TARGET_CHUNK_BYTES);
    expect(Math.max(...plan.chunks.map((chunk) => chunk.request_bytes))).toBeLessThanOrEqual(STAGED_IMPORT_MAX_REQUEST_BYTES);
    expect(plan.chunks.map((chunk) => chunk.content).join('')).toBe(stableJson(core));

    const gateway = new MemoryGateway(cloudExport(manifest));
    gateway.failAfterAcceptingChunk = 0;
    const service = new CloudMigrationService(gateway, PROJECT_ID, { id: 'admin', type: 'agent' });
    await expect(service.importManifest(manifest)).rejects.toThrow(/lost chunk response/);
    const acceptedBeforeResume = gateway.acceptedChunks;
    await service.importManifest(manifest);
    expect(gateway.resumeSnapshots.some((indexes) => indexes.length > 0)).toBe(true);
    expect(gateway.acceptedChunks).toBe(plan.chunks.length);
    expect(gateway.acceptedChunks).toBeGreaterThanOrEqual(acceptedBeforeResume);
    expect(gateway.finalizedImports).toBe(1);
  }, 30_000);

  it('rejects a mismatched retry for an occupied chunk index', async () => {
    const manifest = buildCloudRoadmapManifest(fixtureRepo());
    const gateway = new MemoryGateway(cloudExport(manifest));
    const service = new CloudMigrationService(gateway, PROJECT_ID, { id: 'admin', type: 'agent' });
    await service.importManifest(manifest);
    const upload = gateway.commands.find((entry) => entry.command.kind === 'uploadProjectImportChunk')!;
    const conflicting = structuredClone(upload);
    if (conflicting.command.kind !== 'uploadProjectImportChunk') throw new Error('expected chunk command');
    conflicting.command.content += 'different';
    conflicting.command.byte_count += 9;
    conflicting.command.chunk_hash = sha256(conflicting.command.content);
    gateway.restoreSessionFromCommands();
    await expect(gateway.command(conflicting)).rejects.toThrow(/different bytes/);
  });

  it('compares bounded context semantics independent of wrapper shape and detects changed selection', () => {
    const bounds = { row_count: 2, byte_count: 100, token_estimate: 25, estimator: 'tenbo-token-estimator-v1' as const,
      limits: { rows: 16, bytes: 24 * 1024, tokens: 1500 }, truncated: false };
    const local = { kind: 'context' as const, intent: 'item' as const, payload: { item: { id: 'x-1' }, context: { read_plan: [{ path: '.tenbo/specs/x-1.md' }, { path: '.tenbo/overview.md' }] } }, bounds };
    const cloud = { kind: 'context' as const, intent: 'item' as const, payload: { item: { item: { id: 'x-1' } }, documents: [{ path: '.tenbo/specs/x-1.md' }] }, bounds: { ...bounds, truncation_reason: 'bytes' as const } };
    expect(compareSemanticResults(local, cloud).equal).toBe(true);
    const divergent = { ...cloud, payload: { item: { item: { id: 'x-2' } }, documents: [{ path: '.tenbo/overview.md' }] } };
    expect(compareSemanticResults(local, divergent).equal).toBe(false);
  });
});

class MemoryGateway implements TenboGatewayPort {
  readonly commands: CommandEnvelopeDto[] = [];
  readonly results = new Map<string, TenboCommandResult>();
  readonly resumeSnapshots: number[][] = [];
  readonly chunks = new Map<number, { hash: string; content: string }>();
  session: Extract<CommandEnvelopeDto['command'], { kind: 'beginProjectImport' }> | undefined;
  finalizedImports = 0;
  acceptedChunks = 0;
  failAfterAcceptingChunk: number | undefined;
  constructor(private readonly exported: JsonValue) {}
  async query(_request: QueryEnvelopeDto): Promise<TenboQueryResult> { return { kind: 'projectExport', value: this.exported }; }
  async command(request: CommandEnvelopeDto): Promise<TenboCommandResult> {
    this.commands.push(request);
    if (request.command.kind === 'beginProjectImport') {
      if (this.session && stableJson(this.session) !== stableJson(request.command)) throw new Error('session metadata conflict');
      this.session = request.command;
      const received = [...this.chunks.keys()].sort((a, b) => a - b);
      this.resumeSnapshots.push(received);
      return {
        kind: 'stagedImportSession', session_id: request.command.session_id,
        manifest_hash: request.command.manifest_hash, total_chunks: request.command.total_chunks,
        received_chunks: received, expires_at: '2030-01-01T00:00:00.000Z',
      };
    }
    if (request.command.kind === 'uploadProjectImportChunk') {
      if (!this.session) throw new Error('session missing');
      const existing = this.chunks.get(request.command.chunk_index);
      if (existing && (existing.hash !== request.command.chunk_hash || existing.content !== request.command.content)) {
        throw new Error('chunk index already contains different bytes');
      }
      if (!existing) {
        this.chunks.set(request.command.chunk_index, { hash: request.command.chunk_hash, content: request.command.content });
        this.acceptedChunks += 1;
      }
      if (this.failAfterAcceptingChunk === request.command.chunk_index) {
        this.failAfterAcceptingChunk = undefined;
        throw new Error('lost chunk response');
      }
      return {
        kind: 'stagedImportChunk', session_id: request.command.session_id,
        chunk_index: request.command.chunk_index, received_chunks: this.chunks.size,
        total_chunks: this.session.total_chunks,
      };
    }
    if (request.command.kind === 'finalizeProjectImport') {
      const prior = this.results.get(request.mutation_id);
      if (prior) {
        this.session = undefined;
        this.chunks.clear();
        return prior;
      }
      if (!this.session || this.chunks.size !== this.session.total_chunks) throw new Error('staged import incomplete');
      this.finalizedImports += 1;
      const result = { kind: 'import' as const, imported_items: 3, imported_documents: 2 };
      this.results.set(request.mutation_id, result);
      this.session = undefined;
      this.chunks.clear();
      return result;
    }
    throw new Error(`unexpected command ${request.command.kind}`);
  }

  restoreSessionFromCommands(): void {
    const begin = this.commands.find((entry) => entry.command.kind === 'beginProjectImport')?.command;
    const upload = this.commands.find((entry) => entry.command.kind === 'uploadProjectImportChunk')?.command;
    if (!begin || begin.kind !== 'beginProjectImport' || !upload || upload.kind !== 'uploadProjectImportChunk') throw new Error('missing staged commands');
    this.session = begin;
    this.chunks.set(upload.chunk_index, { hash: upload.chunk_hash, content: upload.content });
  }
}

function fixtureRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-manifest-'));
  roots.push(repo);
  write(repo, '.tenbo/workspace.yaml', 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor\ncross_cutting: []\n');
  write(repo, '.tenbo/roadmap.yaml', 'items:\n  - id: x-1\n    title: Cloud\n    status: now\n    description: cloud\n    spawned_from: ed-1\n');
  write(repo, '.tenbo/scopes/editor/architecture.yaml', 'layers: []\n');
  write(repo, '.tenbo/scopes/editor/roadmap.yaml', 'items:\n  - id: ed-1\n    title: Active\n    status: next\n    description: active\n');
  write(repo, '.tenbo/scopes/editor/roadmap-archive.yaml', [
    'items:', '  - id: ed-2', '    title: Archived', '    status: done', '    description: archived',
    '    priority: p1', '    related: [ed-1]', '    links: ["commit:abc"]',
    '    verification:', '      status: verified', '      evidence: [test]',
    '    phases:', '      - id: 1', '        title: phase', '        status: done', '',
  ].join('\n'));
  write(repo, '.tenbo/specs/x-1.md', '---\ntenbo_item: x-1\n---\n# Spec\n');
  write(repo, '.tenbo/workpads/archive/ed-2.md', '---\nitem: ed-2\n---\n# Workpad\n');
  write(repo, '.tenbo/journal/event.json', JSON.stringify({ mutationId: 'legacy-1', actor: 'worker', timestamp: '2026-01-01T00:00:00.000Z', itemId: 'ed-2', operation: 'complete', requestHash: 'a'.repeat(64), result: { ok: true } }));
  write(repo, '.tenbo/cache/coordination/claims.json', JSON.stringify({ claims: { 'x-1': { item_id: 'x-1', owner: 'worker', fencing_token: 4, version: 2, expires_at: '2030-01-01T00:00:00.000Z' } } }));
  git(repo, ['init', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.test']); git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://example.test/repo.git']); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'fixture']);
  return repo;
}

function cloudExport(manifest: ReturnType<typeof buildCloudRoadmapManifest>): JsonValue {
  return {
    project: { id: PROJECT_ID, repository: manifest.source.repository }, members: [],
    items: manifest.items.map(({ scope_id, position, row_version, archived, ...item }) => ({
      item_data: item, scope_id, position, row_version, archived_at: archived ? '2026-01-01T00:00:00Z' : null,
    })),
    relations: manifest.relations,
    documents: manifest.documents.map((document) => ({ id: document.id, item_id: document.item_id, source_kind: 'planning', document_kind: document.kind, path: document.path, archived_at: document.archived ? '2026-01-01T00:00:00Z' : null })),
    document_versions: manifest.documents.map((document) => ({ document_id: document.id, version_number: 1, content: document.content, content_hash: document.content_hash })),
    mutations: manifest.mutations.map((mutation, index) => ({ id: index + 1, mutation_id: mutation.mutation_id, request_hash: mutation.request_hash,
      actor_type: 'agent', actor_id: mutation.actor, command_name: mutation.operation,
      request_body: { legacy_import: true }, result_json: { kind: 'legacyMutation', mutation_id: mutation.mutation_id },
      entity_type: 'item', entity_id: mutation.item_id, committed_project_version: 1,
      committed_entity_version: null, created_at: mutation.timestamp,
      audit_metadata: { legacy_import: true, source_timestamp: mutation.timestamp, ...(mutation.result !== undefined ? { source_result: mutation.result } : {}) } })),
    claims: manifest.claims.map((claim) => ({ item_id: claim.item_id, owner_id: claim.owner, fencing_token: claim.fencing_token, heartbeat_version: claim.version, expires_at: claim.expires_at })),
  } as unknown as JsonValue;
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, content);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
