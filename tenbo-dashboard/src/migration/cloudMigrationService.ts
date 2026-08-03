import {
  TENBO_SCHEMA_VERSION,
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  type ActorDto,
  type JsonValue,
  type StagedImportCountsDto,
  type TenboCommand,
  type TenboCommandResult,
  type TenboGatewayPort,
  type TenboQuery,
  type TenboQueryResult,
} from '../contracts/tenbo';
import {
  assertCloudRoadmapManifest,
  type CloudRoadmapManifest,
  type MigrationClaim,
  type MigrationItem,
  type MigrationMutation,
  type MigrationPlanningDocument,
  type MigrationRelation,
  sha256,
  stableJson,
} from './cloudRoadmapManifest';

export const CLOUD_RECOVERY_FORMAT = 'tenbo-cloud-recovery-v1' as const;
export const STAGED_IMPORT_TARGET_CHUNK_BYTES = 256 * 1024;
export const STAGED_IMPORT_MAX_REQUEST_BYTES = 900 * 1024;
const STAGED_IMPORT_UPLOAD_CONCURRENCY = 4;

export interface PortableCloudProjection {
  items: MigrationItem[];
  relations: MigrationRelation[];
  documents: MigrationPlanningDocument[];
  mutations: MigrationMutation[];
  claims: MigrationClaim[];
  /** Recovery-only cloud-native state; excluded from roadmap comparison. */
  promotion_attempts?: Record<string, JsonValue>[];
  promotion_git_documents?: Record<string, JsonValue>[];
  document_canonical_states?: Record<string, JsonValue>[];
}

type PortableProjectionCollection = 'items' | 'relations' | 'documents' | 'mutations' | 'claims';

export interface CloudProjectionComparison {
  equal: boolean;
  local_hash: string;
  cloud_hash: string;
  counts: { local: Record<PortableProjectionCollection, number>; cloud: Record<PortableProjectionCollection, number> };
  missing_item_ids: string[];
  unexpected_item_ids: string[];
  differing_item_ids: string[];
}

export interface CloudRecoveryExport {
  format: typeof CLOUD_RECOVERY_FORMAT;
  schema_version: 1;
  project_id: string;
  projection: PortableCloudProjection;
  canonical_hash: string;
}

export interface StagedImportChunk {
  index: number;
  content: string;
  byte_count: number;
  chunk_hash: string;
  request_bytes: number;
}

export interface StagedImportPlan {
  session_id: string;
  manifest_hash: string;
  manifest_format: 'tenbo-cloud-roadmap-v1' | 'tenbo-cloud-recovery-v1';
  manifest_schema_version: 1;
  manifest_bytes: number;
  expected_counts: StagedImportCountsDto;
  replace: boolean;
  begin_mutation_id: string;
  finalize_mutation_id: string;
  chunks: StagedImportChunk[];
}

export interface CloudImportIdentity {
  mode: 'merge' | 'cutover';
  session_id: string;
  mutation_id: string;
}

export function cloudRoadmapImportIdentity(projectId: string, manifestHash: string, replace: boolean): CloudImportIdentity {
  const mode = replace ? 'cutover' : 'merge';
  return {
    mode,
    session_id: sha256(`${projectId}\0${manifestHash}\0${replace ? 'replace' : 'merge'}`),
    mutation_id: `${replace ? 'tenbo-cutover' : 'tenbo-import'}-${manifestHash}`,
  };
}

export class CloudMigrationService {
  constructor(
    private readonly gateway: TenboGatewayPort,
    readonly projectId: string,
    private readonly actor: ActorDto,
  ) {}

  async importManifest(manifest: CloudRoadmapManifest, options: { replace?: boolean } = {}): Promise<TenboCommandResult> {
    assertCloudRoadmapManifest(manifest);
    const { canonical_hash: manifestHash, ...core } = manifest;
    const replace = options.replace === true;
    const identity = cloudRoadmapImportIdentity(this.projectId, manifestHash, replace);
    return this.importStaged(
      core as unknown as JsonValue,
      manifestHash,
      manifest.counts,
      replace,
      identity.mutation_id,
    );
  }

  async exportProjection(options: { includeAllMutations?: boolean } = {}): Promise<PortableCloudProjection> {
    const result = await this.query({ kind: 'exportProject' });
    if (result.kind !== 'projectExport') throw new Error(`expected projectExport, received ${result.kind}`);
    return normalizeCloudExport(result.value, options);
  }

  async recoveryExport(): Promise<CloudRecoveryExport> {
    const projection = await this.exportProjection({ includeAllMutations: true });
    const core = { format: CLOUD_RECOVERY_FORMAT, schema_version: 1 as const, project_id: this.projectId, projection };
    return { ...core, canonical_hash: sha256(stableJson(core)) };
  }

  async restore(recovery: CloudRecoveryExport, confirmProjectId: string): Promise<TenboCommandResult> {
    if (confirmProjectId !== this.projectId || recovery.project_id !== this.projectId) {
      throw new Error('restore requires an exact --confirm-project match for both configured and exported project IDs');
    }
    assertRecoveryExport(recovery);
    const expectedCounts = projectionCounts(recovery.projection);
    const core = {
      format: CLOUD_RECOVERY_FORMAT,
      schema_version: 1 as const,
      counts: expectedCounts,
      item_ids: recovery.projection.items.map((item) => item.id).sort(),
      ...recovery.projection,
    };
    const manifestHash = sha256(stableJson(core));
    return this.importStaged(core as unknown as JsonValue, manifestHash, expectedCounts, true, `tenbo-restore-${recovery.canonical_hash}`);
  }

  async compare(local: CloudRoadmapManifest): Promise<CloudProjectionComparison> {
    return compareProjection(projectionOfManifest(local), await this.exportProjection());
  }

  async shadowRead(local: TenboGatewayPort, query: TenboQuery): Promise<SemanticShadowComparison> {
    const [localResult, cloudResult] = await Promise.all([
      local.query({ schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION, backend_epoch: TENBO_BACKEND_EPOCH, query }),
      this.query(query),
    ]);
    return compareSemanticResults(localResult, cloudResult);
  }

  private query(query: TenboQuery): Promise<TenboQueryResult> {
    return this.gateway.query({ schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION,
      backend_epoch: TENBO_BACKEND_EPOCH, project_id: this.projectId, query });
  }

  private command(mutationId: string, command: Parameters<TenboGatewayPort['command']>[0]['command']): Promise<TenboCommandResult> {
    return this.gateway.command({
      schema_version: TENBO_SCHEMA_VERSION,
      client_version: TENBO_CLIENT_VERSION,
      backend_epoch: TENBO_BACKEND_EPOCH,
      project_id: this.projectId,
      mutation_id: mutationId,
      actor: this.actor,
      command,
    });
  }

  private async importStaged(
    core: JsonValue,
    manifestHash: string,
    expectedCounts: StagedImportCountsDto,
    replace: boolean,
    finalizeMutationId: string,
  ): Promise<TenboCommandResult> {
    const plan = buildStagedImportPlan({
      core,
      manifestHash,
      expectedCounts,
      replace,
      finalizeMutationId,
      projectId: this.projectId,
      actor: this.actor,
    });
    const begun = await this.command(plan.begin_mutation_id, beginCommand(plan));
    if (begun.kind !== 'stagedImportSession') throw new Error(`expected stagedImportSession, received ${begun.kind}`);
    if (begun.session_id !== plan.session_id || begun.manifest_hash !== plan.manifest_hash || begun.total_chunks !== plan.chunks.length) {
      throw new Error('cloud staged-import session metadata does not match the deterministic local plan');
    }
    const received = new Set(begun.received_chunks);
    const pending = plan.chunks.filter((chunk) => !received.has(chunk.index));
    await parallelLimit(pending, STAGED_IMPORT_UPLOAD_CONCURRENCY, async (chunk) => {
      const result = await this.command(chunkMutationId(plan, chunk.index), chunkCommand(plan, chunk));
      if (result.kind !== 'stagedImportChunk' || result.session_id !== plan.session_id || result.chunk_index !== chunk.index) {
        throw new Error(`cloud returned an invalid acknowledgement for staged-import chunk ${chunk.index}`);
      }
    });
    return this.command(plan.finalize_mutation_id, { kind: 'finalizeProjectImport', session_id: plan.session_id });
  }
}

export function buildStagedImportPlan(options: {
  core: JsonValue;
  manifestHash: string;
  expectedCounts: StagedImportCountsDto;
  replace: boolean;
  finalizeMutationId: string;
  projectId: string;
  actor: ActorDto;
}): StagedImportPlan {
  const canonicalText = stableJson(options.core);
  const computedHash = sha256(canonicalText);
  if (computedHash !== options.manifestHash) throw new Error('staged import core does not match its declared canonical hash');
  const sessionId = sha256(`${options.projectId}\0${computedHash}\0${options.replace ? 'replace' : 'merge'}`);
  const base = {
    session_id: sessionId,
    manifest_hash: computedHash,
    manifest_format: importFormat(options.core),
    manifest_schema_version: 1 as const,
    manifest_bytes: utf8Bytes(canonicalText),
    expected_counts: options.expectedCounts,
    replace: options.replace,
    begin_mutation_id: `${options.finalizeMutationId}-begin`,
    finalize_mutation_id: options.finalizeMutationId,
  };
  let contentChunks = splitUtf8(canonicalText, STAGED_IMPORT_TARGET_CHUNK_BYTES);
  while (true) {
    const totalChunks = contentChunks.length;
    const next: string[] = [];
    let changed = false;
    for (let index = 0; index < contentChunks.length; index += 1) {
      const content = contentChunks[index]!;
      const requestBytes = commandEnvelopeBytes(
        options.projectId,
        options.actor,
        `${options.finalizeMutationId}-chunk-${index}`,
        rawChunkCommand(sessionId, index, content),
      );
      if (requestBytes <= STAGED_IMPORT_MAX_REQUEST_BYTES) {
        next.push(content);
      } else {
        const halves = splitUtf8(content, Math.max(1, Math.floor(utf8Bytes(content) / 2)));
        if (halves.length < 2) throw new Error(`staged-import chunk cannot fit below ${STAGED_IMPORT_MAX_REQUEST_BYTES} bytes`);
        next.push(...halves);
        changed = true;
      }
    }
    contentChunks = next;
    if (!changed) {
      const chunks = contentChunks.map((content, index) => {
        const command = rawChunkCommand(sessionId, index, content);
        return {
          index,
          content,
          byte_count: utf8Bytes(content),
          chunk_hash: sha256(content),
          request_bytes: commandEnvelopeBytes(options.projectId, options.actor, `${options.finalizeMutationId}-chunk-${index}`, command),
        };
      });
      if (chunks.length !== totalChunks) throw new Error('staged-import chunk planning did not converge');
      return { ...base, chunks };
    }
  }
}

function beginCommand(plan: StagedImportPlan): Extract<TenboCommand, { kind: 'beginProjectImport' }> {
  return {
    kind: 'beginProjectImport', session_id: plan.session_id, manifest_hash: plan.manifest_hash,
    manifest_format: plan.manifest_format, manifest_schema_version: plan.manifest_schema_version,
    manifest_bytes: plan.manifest_bytes, total_chunks: plan.chunks.length,
    expected_counts: plan.expected_counts, replace: plan.replace,
  };
}

function rawChunkCommand(sessionId: string, index: number, content: string): Extract<TenboCommand, { kind: 'uploadProjectImportChunk' }> {
  return {
    kind: 'uploadProjectImportChunk', session_id: sessionId, chunk_index: index,
    chunk_hash: sha256(content), byte_count: utf8Bytes(content), content,
  };
}

function chunkCommand(plan: StagedImportPlan, chunk: StagedImportChunk): Extract<TenboCommand, { kind: 'uploadProjectImportChunk' }> {
  return {
    kind: 'uploadProjectImportChunk', session_id: plan.session_id, chunk_index: chunk.index,
    chunk_hash: chunk.chunk_hash, byte_count: chunk.byte_count, content: chunk.content,
  };
}

function chunkMutationId(plan: StagedImportPlan, index: number): string {
  return `${plan.finalize_mutation_id}-chunk-${index}`;
}

function commandEnvelopeBytes(projectId: string, actor: ActorDto, mutationId: string, command: TenboCommand): number {
  return utf8Bytes(JSON.stringify({ schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION,
    backend_epoch: TENBO_BACKEND_EPOCH, project_id: projectId, mutation_id: mutationId, actor, command }));
}

function importFormat(core: JsonValue): StagedImportPlan['manifest_format'] {
  if (!core || typeof core !== 'object' || Array.isArray(core)) throw new Error('staged import core must be an object');
  const format = core.format;
  if (format !== 'tenbo-cloud-roadmap-v1' && format !== CLOUD_RECOVERY_FORMAT) throw new Error('unsupported staged import format');
  if (core.schema_version !== 1) throw new Error('unsupported staged import schema version');
  return format;
}

function splitUtf8(value: string, targetBytes: number): string[] {
  if (value === '') return [''];
  const bytes = Buffer.from(value, 'utf8');
  const chunks: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + targetBytes, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === offset) throw new Error('staged-import chunk boundary could not preserve UTF-8');
    chunks.push(bytes.subarray(offset, end).toString('utf8'));
    offset = end;
  }
  return chunks;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

async function parallelLimit<T>(values: T[], concurrency: number, operation: (value: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index]!);
    }
  }));
}

function projectionCounts(projection: PortableCloudProjection): StagedImportCountsDto {
  return {
    items: projection.items.length,
    active_items: projection.items.filter((item) => !item.archived).length,
    archived_items: projection.items.filter((item) => item.archived).length,
    relations: projection.relations.length,
    documents: projection.documents.length,
    mutations: projection.mutations.length,
    claims: projection.claims.length,
  };
}

export function projectionOfManifest(manifest: CloudRoadmapManifest): PortableCloudProjection {
  assertCloudRoadmapManifest(manifest);
  return sortProjection({
    items: manifest.items,
    relations: manifest.relations,
    documents: manifest.documents,
    mutations: manifest.mutations,
    claims: manifest.claims,
  });
}

export function normalizeCloudExport(value: JsonValue, options: { includeAllMutations?: boolean } = {}): PortableCloudProjection {
  const root = object(value, 'cloud export');
  const items = array(root.items).map((entry) => {
    const row = object(entry, 'cloud item');
    const itemData = object(row.item_data, 'cloud item_data');
    return {
      ...itemData,
      scope_id: string(row.scope_id),
      position: number(row.position),
      row_version: number(row.row_version),
      archived: row.archived_at !== null && row.archived_at !== undefined,
    } as unknown as MigrationItem;
  });
  const relations = array(root.relations).map((entry) => {
    const row = object(entry, 'cloud relation');
    return {
      source_item_id: string(row.source_item_id), target_item_id: string(row.target_item_id),
      relation_type: string(row.relation_type), metadata: object(row.metadata, 'relation metadata'),
    } as MigrationRelation;
  });
  const versions = array(root.document_versions).map((entry) => object(entry, 'document version'));
  const rawDocuments = array(root.documents).map((entry) => object(entry, 'cloud document'));
  const documents = rawDocuments
    .filter((row) => row.source_kind === 'planning')
    .map((row) => {
      const documentVersions = versions.filter((version) => version.document_id === row.id)
        .sort((a, b) => number(b.version_number) - number(a.version_number));
      const latest = documentVersions[0];
      if (!latest) throw new Error(`planning document ${string(row.path)} has no version`);
      return {
        id: string(row.id), item_id: string(row.item_id), kind: string(row.document_kind), path: string(row.path),
        content: string(latest.content), content_hash: string(latest.content_hash),
        archived: row.archived_at !== null && row.archived_at !== undefined,
      } as MigrationPlanningDocument;
    });
  const mutations = array(root.mutations).map((entry) => object(entry, 'cloud mutation'))
    .filter((row) => options.includeAllMutations || objectOrEmpty(row.audit_metadata).legacy_import === true)
    .map((row) => {
      const audit = objectOrEmpty(row.audit_metadata);
      const legacy = audit.legacy_import === true;
      return {
        mutation_id: string(row.mutation_id), actor: string(row.actor_id), timestamp: string(legacy ? audit.source_timestamp ?? row.created_at : row.created_at),
        item_id: string(row.entity_id), operation: string(row.command_name), request_hash: string(row.request_hash),
        ...(legacy && audit.source_result !== undefined ? { result: audit.source_result }
          : !legacy && row.result_json !== undefined ? { result: row.result_json } : {}),
        ...(options.includeAllMutations ? {
          recovery_record: {
            mutation_id: string(row.mutation_id), request_hash: string(row.request_hash),
            actor_type: string(row.actor_type), actor_id: string(row.actor_id),
            command_name: string(row.command_name), request_body: row.request_body,
            result_json: row.result_json, entity_type: nullableString(row.entity_type),
            entity_id: nullableString(row.entity_id), committed_project_version: number(row.committed_project_version),
            committed_entity_version: nullableNumber(row.committed_entity_version),
            audit_metadata: audit, created_at: string(row.created_at),
          },
        } : {}),
      } as MigrationMutation;
    });
  const claims = array(root.claims).map((entry) => {
    const row = object(entry, 'cloud claim');
    return {
      item_id: string(row.item_id), owner: string(row.owner_id), fencing_token: number(row.fencing_token),
      version: number(row.heartbeat_version), expires_at: string(row.expires_at),
    } as MigrationClaim;
  });
  const promotionAttempts = options.includeAllMutations
    ? array(root.promotion_attempts).map((entry) => object(entry, 'promotion attempt'))
    : undefined;
  const promotedGitIds = new Set((promotionAttempts ?? []).flatMap((attempt) =>
    typeof attempt.git_document_id === 'string' ? [attempt.git_document_id] : []));
  const promotionGitDocuments = options.includeAllMutations
    ? rawDocuments.filter((row) => row.source_kind === 'git' && promotedGitIds.has(string(row.id))).map((row) => {
      const latest = versions.filter((version) => version.document_id === row.id)
        .sort((a, b) => number(b.version_number) - number(a.version_number))[0];
      if (!latest) throw new Error(`promoted Git document ${string(row.path)} has no version`);
      return {
        id: string(row.id), kind: string(row.document_kind), path: string(row.path),
        repository: string(row.repository), commit_sha: string(row.commit_sha),
        content_hash: string(row.content_hash), content: string(latest.content),
      };
    })
    : undefined;
  const documentCanonicalStates = options.includeAllMutations
    ? rawDocuments.filter((row) => row.source_kind === 'planning' && row.canonical_read_only_at != null).map((row) => ({
      document_id: string(row.id), canonical_read_only_at: string(row.canonical_read_only_at),
      promoted_git_document_id: string(row.promoted_git_document_id),
    }))
    : undefined;
  return sortProjection({
    items, relations, documents, mutations, claims,
    ...(promotionAttempts ? { promotion_attempts: promotionAttempts } : {}),
    ...(promotionGitDocuments ? { promotion_git_documents: promotionGitDocuments } : {}),
    ...(documentCanonicalStates ? { document_canonical_states: documentCanonicalStates } : {}),
  });
}

export function compareProjection(local: PortableCloudProjection, cloud: PortableCloudProjection): CloudProjectionComparison {
  const normalizedLocal = sortProjection(local);
  const normalizedCloud = sortProjection(cloud);
  const localHash = sha256(stableJson(portableCore(normalizedLocal)));
  const cloudHash = sha256(stableJson(portableCore(normalizedCloud)));
  const localById = new Map(normalizedLocal.items.map((item) => [item.id, item]));
  const cloudById = new Map(normalizedCloud.items.map((item) => [item.id, item]));
  return {
    equal: localHash === cloudHash,
    local_hash: localHash,
    cloud_hash: cloudHash,
    counts: { local: counts(normalizedLocal), cloud: counts(normalizedCloud) },
    missing_item_ids: [...localById.keys()].filter((id) => !cloudById.has(id)).sort(),
    unexpected_item_ids: [...cloudById.keys()].filter((id) => !localById.has(id)).sort(),
    differing_item_ids: [...localById.keys()].filter((id) => cloudById.has(id) && stableJson(localById.get(id)) !== stableJson(cloudById.get(id))).sort(),
  };
}

export interface SemanticShadowComparison {
  equal: boolean;
  local: SemanticResult;
  cloud: SemanticResult;
  local_hash: string;
  cloud_hash: string;
}

export interface SemanticResult {
  kind: string;
  intent?: string;
  item_ids: string[];
  document_paths: string[];
  bounds?: { limits: unknown; truncated: boolean };
}

export function compareSemanticResults(local: TenboQueryResult, cloud: TenboQueryResult): SemanticShadowComparison {
  const localSemantic = semanticResult(local);
  const cloudSemantic = semanticResult(cloud);
  const localHash = sha256(stableJson(localSemantic));
  const cloudHash = sha256(stableJson(cloudSemantic));
  return { equal: localHash === cloudHash, local: localSemantic, cloud: cloudSemantic, local_hash: localHash, cloud_hash: cloudHash };
}

function semanticResult(result: TenboQueryResult): SemanticResult {
  const paths = new Set<string>();
  const ids = new Set<string>();
  collectSemantic(result as unknown as JsonValue, ids, paths);
  const base: SemanticResult = { kind: result.kind, item_ids: [...ids].sort(), document_paths: [...paths].sort() };
  if (result.kind === 'context') {
    base.intent = result.intent;
    base.bounds = {
      limits: result.bounds.limits,
      truncated: result.bounds.truncated,
    };
  }
  return base;
}

function collectSemantic(value: JsonValue, ids: Set<string>, paths: Set<string>): void {
  if (Array.isArray(value)) { for (const child of value) collectSemantic(child, ids, paths); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if ((key === 'id' || key === 'item_id' || key === 'itemId') && typeof child === 'string' && /^[a-z][a-z0-9-]*-[0-9]+(?:\.[a-z0-9]+)*$/.test(child)) ids.add(child);
    if ((key === 'path' || key === 'workpad') && typeof child === 'string' && /^\.tenbo\/(specs|workpads)\//.test(child)) paths.add(child);
    collectSemantic(child, ids, paths);
  }
}

function sortProjection(projection: PortableCloudProjection): PortableCloudProjection {
  return {
    items: [...projection.items].sort((a, b) => a.scope_id.localeCompare(b.scope_id) || Number(a.archived) - Number(b.archived) || a.position - b.position || a.id.localeCompare(b.id)),
    relations: [...projection.relations].sort((a, b) => a.source_item_id.localeCompare(b.source_item_id) || a.relation_type.localeCompare(b.relation_type) || a.target_item_id.localeCompare(b.target_item_id)),
    documents: [...projection.documents].sort((a, b) => a.path.localeCompare(b.path)),
    mutations: [...projection.mutations].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.mutation_id.localeCompare(b.mutation_id)),
    claims: [...projection.claims].sort((a, b) => a.item_id.localeCompare(b.item_id)),
    ...(projection.promotion_attempts ? { promotion_attempts: [...projection.promotion_attempts].sort(jsonRowOrder) } : {}),
    ...(projection.promotion_git_documents ? { promotion_git_documents: [...projection.promotion_git_documents].sort(jsonRowOrder) } : {}),
    ...(projection.document_canonical_states ? { document_canonical_states: [...projection.document_canonical_states].sort(jsonRowOrder) } : {}),
  };
}

function counts(projection: PortableCloudProjection): Record<PortableProjectionCollection, number> {
  return { items: projection.items.length, relations: projection.relations.length, documents: projection.documents.length, mutations: projection.mutations.length, claims: projection.claims.length };
}

function portableCore(projection: PortableCloudProjection): Pick<PortableCloudProjection, PortableProjectionCollection> {
  return {
    items: projection.items, relations: projection.relations, documents: projection.documents,
    mutations: projection.mutations, claims: projection.claims,
  };
}

function jsonRowOrder(left: Record<string, JsonValue>, right: Record<string, JsonValue>): number {
  return stableJson(left).localeCompare(stableJson(right));
}

function assertRecoveryExport(value: CloudRecoveryExport): void {
  if (value.format !== CLOUD_RECOVERY_FORMAT || value.schema_version !== 1) throw new Error('unsupported recovery export');
  const { canonical_hash: claimed, ...core } = value;
  if (claimed !== sha256(stableJson(core))) throw new Error('recovery export canonical_hash mismatch');
}

function object(value: JsonValue | undefined, name: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function objectOrEmpty(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function string(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('cloud export string field missing');
  return value;
}

function nullableString(value: JsonValue | undefined): string | null {
  return value === null || value === undefined ? null : string(value);
}

function nullableNumber(value: JsonValue | undefined): number | null {
  return value === null || value === undefined ? null : number(value);
}

function number(value: JsonValue | undefined): number {
  if (typeof value !== 'number') throw new Error('cloud export number field missing');
  return value;
}
