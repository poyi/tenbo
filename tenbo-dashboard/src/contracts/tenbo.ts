import type {
  Item,
  Priority,
  Status,
  ValidateResult,
  VerificationStatus,
} from '../types';

/**
 * Transport-neutral Tenbo contract.
 *
 * This module intentionally imports no Node, browser, HTTP, filesystem, or
 * Supabase implementation. Browser clients, CLI clients, local backends, and
 * cloud backends all exchange these DTOs.
 */
export const TENBO_SCHEMA_VERSION = 1 as const;
/** Package/protocol release sent to the gateway for project minimum-version enforcement. */
export const TENBO_CLIENT_VERSION = '0.15.2-cloudfix.5' as const;
/** Epoch increments only when a project requires a non-backward-compatible backend contract. */
export const TENBO_BACKEND_EPOCH = 1 as const;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ActorDto {
  id: string;
  type: 'user' | 'agent' | 'system';
}

export interface PageRequestDto {
  cursor?: string;
  limit?: number;
}

export interface PageMetaDto {
  row_count: number;
  has_more: boolean;
  next_cursor?: string;
}

export interface ItemRecordDto {
  scope_id: string;
  item: Item;
  /** Opaque optimistic-concurrency version. */
  version: string;
  archived: boolean;
  /** Canonical prerequisite projection; cloud storage remains relation-table-owned. */
  depends_on?: string[];
  unresolved_blockers?: Array<{ item_id: string; status: Status | 'missing' }>;
  readiness?: 'ready' | 'blocked';
  specification?: PlanningDocumentMetadataDto;
  /** Every specification attached to the item, including archived history. */
  specifications?: PlanningDocumentMetadataDto[];
}

export interface ItemPageDto {
  items: ItemRecordDto[];
  page: PageMetaDto;
}

export interface ItemFiltersDto {
  status?: Status | Status[];
  verification?: VerificationStatus;
  goal?: string;
  type?: Item['type'];
  priority?: Priority;
  layer?: string;
  scope_id?: string;
  archived?: boolean;
  search?: string;
}

export type ItemCreateDto = Pick<Item, 'id' | 'title' | 'status' | 'description'>
  & Partial<Omit<Item, 'id' | 'title' | 'status' | 'description'>>;

/** Fields changed through updateRichFields. Status, notes, and verification have dedicated commands. */
export type ItemRichPatchDto = Partial<Pick<Item,
  | 'title'
  | 'description'
  | 'layer'
  | 'layers'
  | 'links'
  | 'affects'
  | 'done_when'
  | 'files_to_read'
  | 'risks'
  | 'type'
  | 'priority'
  | 'goal_ref'
  | 'phases'
  | 'spawned_from'
  | 'superseded_by'
  | 'related'
  | 'workpad'
  | 'doc_update'
  | 'dispatch_attempts'
  | 'bar_override'
>>;

export type PlanningDocumentKind = 'spec' | 'workpad' | 'handoff';

export interface PlanningDocumentMetadataDto {
  id: string;
  item_id: string;
  source_kind: 'planning';
  kind: PlanningDocumentKind;
  path: string;
  version: string;
  archived: boolean;
  content_hash: string;
  summary: string;
  token_estimate: number;
  content_bytes: number;
}

export interface DocumentSearchResultDto {
  id: string;
  item_id?: string;
  source_kind: 'planning' | 'git';
  kind: string;
  path: string;
  version: string;
  archived: boolean;
  content_hash: string;
  summary: string;
  excerpt: string;
  token_estimate: number;
  content_bytes: number;
}

export interface DocumentVersionDto {
  document_id: string;
  version: string;
  content_hash: string;
  summary: string;
  token_estimate: number;
  content_bytes: number;
  authored_by_type: ActorDto['type'];
  authored_by_id: string;
  created_at: string;
}

export type DocumentPromotionStatus = 'pending' | 'merged' | 'finalized' | 'abandoned' | 'rejected';

export interface DocumentPromotionAttemptDto {
  id: string;
  item_id: string;
  source_document_id: string;
  source_version: string;
  source_content_hash: string;
  target_repository: string;
  target_path: string;
  status: DocumentPromotionStatus;
  merged_commit_sha?: string;
  git_document_id?: string;
  created_by_type: ActorDto['type'];
  created_by_id: string;
  version: string;
  created_at: string;
  updated_at: string;
}

export interface PlanningDocumentDto {
  id: string;
  item_id: string;
  source_kind: 'planning';
  kind: PlanningDocumentKind;
  path: string;
  content: string;
  version: string;
  archived: boolean;
}

export interface GitDocumentDto {
  id: string;
  source_kind: 'git';
  kind: string;
  path: string;
  repository: string;
  commit_sha: string;
  content_hash: string;
  content: string;
  version: string;
  archived: false;
}

export type TenboDocumentDto = PlanningDocumentDto | GitDocumentDto;

export interface StagedImportCountsDto {
  items: number;
  active_items: number;
  archived_items: number;
  relations: number;
  documents: number;
  mutations: number;
  claims: number;
}

export interface ItemClaimDto {
  item_id: string;
  owner: string;
  fencing_token: number;
  version: number;
  expires_at: string;
}

export type ProjectRoleDto = 'viewer' | 'editor' | 'admin';

/** A membership-scoped project projection safe to return to a signed-in browser. */
export interface ProjectSummaryDto {
  id: string;
  slug: string;
  name: string;
  repository: string;
  role: ProjectRoleDto;
  schema_version: number;
  backend_epoch: number;
  minimum_cli_version?: string;
  cutover_at?: string | null;
  project_version: number;
}

export interface ProjectPageDto {
  projects: ProjectSummaryDto[];
  page: PageMetaDto;
}

export interface ActiveClaimDto extends ItemClaimDto {
  scope_id: string;
  item_title: string;
  files_to_read: string[];
}

export interface ActiveClaimPageDto {
  claims: ActiveClaimDto[];
  page: PageMetaDto;
}

export interface ContextBoundsDto {
  row_count: number;
  byte_count: number;
  token_estimate: number;
  estimator: 'tenbo-token-estimator-v1';
  limits: { rows: number; bytes: number; tokens: number };
  truncated: boolean;
  truncation_reason?: 'rows' | 'bytes' | 'tokens';
  continuation_cursor?: string;
}

export interface ContextResultDto {
  kind: 'context';
  intent: 'feature' | 'session' | 'item';
  payload: JsonValue;
  bounds: ContextBoundsDto;
}

export type TenboQuery =
  | { kind: 'getProjectIdentity' }
  | { kind: 'listProjects'; page?: PageRequestDto }
  | { kind: 'listItems'; filters?: ItemFiltersDto; page?: PageRequestDto; projection?: 'full' | 'summary' }
  | { kind: 'getItem'; item_id: string; include_archived?: boolean }
  | { kind: 'getItemClaim'; item_id: string }
  | { kind: 'listActiveClaims'; page?: PageRequestDto }
  | { kind: 'getWorkQueue'; filters?: ItemFiltersDto; page?: PageRequestDto }
  | { kind: 'getSessionContext' }
  | { kind: 'searchContext'; query: string }
  | {
      kind: 'getItemContext';
      item_id: string;
      document_mode?: 'summary' | 'section' | 'full';
      section?: string;
      continuation_cursor?: string;
    }
  | { kind: 'getDocument'; document_id: string }
  | { kind: 'getDocumentVersions'; document_id: string; page?: PageRequestDto }
  | { kind: 'compareDocumentVersions'; document_id: string; from_version: string; to_version: string }
  | { kind: 'listDocumentPromotions'; item_id?: string; document_id?: string; attempt_id?: string; page?: PageRequestDto }
  | { kind: 'searchDocuments'; query: string; kind_filter?: PlanningDocumentKind; page?: PageRequestDto }
  | { kind: 'getMutationHistory'; item_id?: string; page?: PageRequestDto }
  | { kind: 'exportProject' };

export interface QueryEnvelopeDto<Q extends TenboQuery = TenboQuery> {
  schema_version: typeof TENBO_SCHEMA_VERSION;
  client_version?: string;
  backend_epoch?: number;
  project_id?: string;
  query: Q;
}

export type MutationHistoryEntryDto = {
  mutation_id: string;
  actor: string;
  actor_type?: ActorDto['type'];
  timestamp: string;
  item_id: string;
  operation: string;
};

export type TenboQueryResult =
  | { kind: 'projectIdentity'; value: ProjectIdentityDto }
  | { kind: 'projectPage'; value: ProjectPageDto }
  | { kind: 'itemPage'; value: ItemPageDto }
  | { kind: 'item'; value: ItemRecordDto }
  | { kind: 'claim'; value: ItemClaimDto | null }
  | { kind: 'activeClaimPage'; value: ActiveClaimPageDto }
  | ContextResultDto
  | { kind: 'document'; value: TenboDocumentDto }
  | { kind: 'documentPage'; value: Array<TenboDocumentDto | DocumentSearchResultDto>; page: PageMetaDto }
  | { kind: 'documentVersionPage'; value: DocumentVersionDto[]; page: PageMetaDto }
  | { kind: 'documentDiff'; value: JsonValue }
  | { kind: 'promotionPage'; value: DocumentPromotionAttemptDto[]; page: PageMetaDto }
  | { kind: 'mutationHistory'; value: MutationHistoryEntryDto[]; page: PageMetaDto }
  | { kind: 'projectExport'; value: JsonValue };

export type TenboCommand =
  | { kind: 'allocateItemId'; prefix: string; scope_id?: string }
  | { kind: 'createItem'; scope_id: string; item: ItemCreateDto }
  | { kind: 'updateRichFields'; item_id: string; patch: ItemRichPatchDto; expected_version?: string }
  | { kind: 'setStatus'; item_id: string; status: Status; expected_version?: string }
  | { kind: 'reorderItems'; scope_id: string; item_ids: string[]; expected_list_version?: string }
  | { kind: 'archiveItem'; item_id: string; expected_version?: string }
  | { kind: 'reopenItem'; item_id: string; status?: Exclude<Status, 'done' | 'dropped'>; expected_version?: string }
  | { kind: 'addNote'; item_id: string; note: string; expected_version?: string }
  | {
      kind: 'setVerification';
      item_id: string;
      status: VerificationStatus;
      evidence?: string[];
      note?: string;
      expected_version?: string;
    }
  | { kind: 'setDocUpdate'; item_id: string; doc_update: string; expected_version?: string }
  | { kind: 'linkCommit'; item_id: string; commit: string; expected_version?: string }
  | {
      kind: 'completeItem';
      item_id: string;
      evidence: string[];
      doc_update?: string;
      commit?: string;
      verification_status?: VerificationStatus;
      expected_version?: string;
    }
  | { kind: 'claimItem'; item_id: string; owner: string; lease_seconds?: number }
  | { kind: 'renewClaim'; item_id: string; owner: string; fencing_token: number; lease_seconds?: number }
  | { kind: 'releaseClaim'; item_id: string; owner: string; fencing_token: number }
  | {
      kind: 'addDependency';
      item_id: string;
      prerequisite_id: string;
      expected_version?: string;
      fencing_token?: number;
    }
  | {
      kind: 'removeDependency';
      item_id: string;
      prerequisite_id: string;
      expected_version?: string;
      fencing_token?: number;
    }
  | {
      kind: 'createPlanningDocument';
      item_id: string;
      document_kind: PlanningDocumentKind;
      slug?: string;
      content: string;
      fencing_token?: number;
    }
  | {
      kind: 'updatePlanningDocument';
      document_id: string;
      content: string;
      expected_version: string;
      fencing_token?: number;
    }
  | {
      kind: 'replacePlanningDocumentSection';
      document_id: string;
      heading: string;
      content: string;
      expected_version: string;
      expected_section_hash: string;
      fencing_token?: number;
    }
  | {
      kind: 'appendPlanningDocumentSection';
      document_id: string;
      heading: string;
      content: string;
      expected_version: string;
      fencing_token?: number;
    }
  | {
      kind: 'restorePlanningDocumentVersion';
      document_id: string;
      version: string;
      expected_version: string;
      fencing_token?: number;
    }
  | { kind: 'archivePlanningDocument'; document_id: string; expected_version: string; fencing_token?: number }
  | { kind: 'restorePlanningDocument'; document_id: string; expected_version: string; fencing_token?: number }
  | {
      kind: 'beginDocumentPromotion';
      document_id: string;
      expected_version: string;
      source_content_hash: string;
      target_repository: string;
      target_path: string;
      fencing_token: number;
    }
  | { kind: 'abandonDocumentPromotion'; attempt_id: string; expected_version: string; fencing_token: number }
  | {
      /** Trusted CI/admin command. Content must come from the exact commit target path. */
      kind: 'finalizeDocumentPromotion';
      attempt_id: string;
      repository: string;
      commit_sha: string;
      path: string;
      content_hash: string;
      content: string;
    }
  | {
      /** Trusted CI/admin command. Callers must derive content from the exact commit, never arbitrary CLI bytes. */
      kind: 'ingestGitDocument';
      repository: string;
      commit_sha: string;
      path: string;
      document_kind: string;
      content_hash: string;
      content: string;
    }
  | { kind: 'importProject'; manifest: JsonValue; /** Guarded recovery only: replace project state instead of merging. */ replace?: boolean }
  | {
      kind: 'beginProjectImport';
      session_id: string;
      manifest_hash: string;
      manifest_format: 'tenbo-cloud-roadmap-v1' | 'tenbo-cloud-recovery-v1';
      manifest_schema_version: 1;
      manifest_bytes: number;
      total_chunks: number;
      expected_counts: StagedImportCountsDto;
      replace: boolean;
    }
  | {
      kind: 'uploadProjectImportChunk';
      session_id: string;
      chunk_index: number;
      chunk_hash: string;
      byte_count: number;
      content: string;
    }
  | { kind: 'finalizeProjectImport'; session_id: string };

export interface CommandEnvelopeDto<C extends TenboCommand = TenboCommand> {
  schema_version: typeof TENBO_SCHEMA_VERSION;
  client_version?: string;
  backend_epoch?: number;
  mutation_id: string;
  project_id?: string;
  actor: ActorDto;
  command: C;
}

export type TenboCommandResult =
  | { kind: 'allocation'; item_id: string }
  | { kind: 'item'; value: ItemRecordDto; validation?: ValidateResult; newly_unblocked?: string[] }
  | { kind: 'reorder'; scope_id: string; item_ids: string[]; list_version: string }
  | { kind: 'claim'; value: ItemClaimDto }
  | { kind: 'claimReleased'; item_id: string; fencing_token: number }
  | { kind: 'document'; value: PlanningDocumentDto }
  | { kind: 'gitDocument'; value: GitDocumentDto }
  | { kind: 'promotion'; value: DocumentPromotionAttemptDto; git_document?: GitDocumentDto }
  | { kind: 'promotionRejected'; value: DocumentPromotionAttemptDto; reason: string }
  | { kind: 'import'; imported_items: number; imported_documents: number; imported_mutations?: number; imported_claims?: number; project_version?: string }
  | {
      kind: 'stagedImportSession';
      session_id: string;
      manifest_hash: string;
      total_chunks: number;
      received_chunks: number[];
      expires_at: string;
    }
  | {
      kind: 'stagedImportChunk';
      session_id: string;
      chunk_index: number;
      received_chunks: number;
      total_chunks: number;
    };

export interface ItemQueryPort {
  listItems(filters?: ItemFiltersDto, page?: PageRequestDto): Promise<ItemPageDto>;
  getItem(itemId: string, includeArchived?: boolean): Promise<ItemRecordDto>;
  getWorkQueue(filters?: ItemFiltersDto, page?: PageRequestDto): Promise<ItemPageDto>;
}

export interface ItemCommandPort {
  execute(command: Extract<TenboCommand, {
    kind:
      | 'allocateItemId'
      | 'createItem'
      | 'updateRichFields'
      | 'setStatus'
      | 'reorderItems'
      | 'archiveItem'
      | 'reopenItem'
      | 'addNote'
      | 'setVerification'
      | 'setDocUpdate'
      | 'linkCommit'
      | 'completeItem'
      | 'addDependency'
      | 'removeDependency';
  }>, actor: ActorDto): Promise<TenboCommandResult>;
}

export interface ContextQueryPort {
  session(): Promise<ContextResultDto>;
  feature(query: string): Promise<ContextResultDto>;
  item(itemId: string): Promise<ContextResultDto>;
}

export interface CoordinationPort {
  execute(command: Extract<TenboCommand, { kind: 'claimItem' | 'renewClaim' | 'releaseClaim' }>, actor: ActorDto): Promise<TenboCommandResult>;
}

export interface PlanningDocumentPort {
  get(documentId: string): Promise<TenboDocumentDto>;
  search(query: string, kind: PlanningDocumentKind | undefined, page?: PageRequestDto): Promise<{
    documents: Array<TenboDocumentDto | DocumentSearchResultDto>;
    page: PageMetaDto;
  }>;
  execute(command: Extract<TenboCommand, {
    kind: 'createPlanningDocument' | 'updatePlanningDocument' | 'replacePlanningDocumentSection'
      | 'appendPlanningDocumentSection' | 'restorePlanningDocumentVersion'
      | 'archivePlanningDocument' | 'restorePlanningDocument';
  }>, actor: ActorDto): Promise<TenboCommandResult>;
}

export interface ProjectIdentityDto {
  id: string;
  repository: string;
}

export interface ProjectPort {
  getIdentity(): Promise<ProjectIdentityDto>;
  history(itemId: string | undefined, page?: PageRequestDto): Promise<{ entries: MutationHistoryEntryDto[]; page: PageMetaDto }>;
  exportProject(): Promise<JsonValue>;
  importProject(manifest: JsonValue, actor: ActorDto, replace?: boolean): Promise<TenboCommandResult>;
  executeStagedImport(command: Extract<TenboCommand, {
    kind: 'beginProjectImport' | 'uploadProjectImportChunk' | 'finalizeProjectImport';
  }>, actor: ActorDto): Promise<TenboCommandResult>;
}

export interface GitDocumentIngestPort {
  execute(command: Extract<TenboCommand, { kind: 'ingestGitDocument' }>, actor: ActorDto): Promise<TenboCommandResult>;
}

/** Composite of deliberately small domain ports; implementations should not collapse this into one storage god object. */
export interface TenboBackendPorts {
  items: ItemQueryPort & ItemCommandPort;
  context: ContextQueryPort;
  coordination: CoordinationPort;
  documents: PlanningDocumentPort;
  gitDocuments: GitDocumentIngestPort;
  project: ProjectPort;
}

export interface TenboGatewayPort {
  query(request: QueryEnvelopeDto): Promise<TenboQueryResult>;
  command(request: CommandEnvelopeDto): Promise<TenboCommandResult>;
}

export class TenboContractError extends Error {
  constructor(
    public readonly code: 'invalid_request' | 'conflict' | 'not_found' | 'unsupported' | 'permission_denied',
    message: string,
  ) {
    super(message);
    this.name = 'TenboContractError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TenboContractError('invalid_request', `${field} must be a non-empty string`);
  }
  return value;
}

/** Runtime schema guard used at HTTP and CLI boundaries. */
export function parseCommandEnvelope(value: unknown): CommandEnvelopeDto {
  if (!isRecord(value)) throw new TenboContractError('invalid_request', 'command request must be an object');
  if (value.schema_version !== TENBO_SCHEMA_VERSION) {
    throw new TenboContractError('invalid_request', `unsupported schema_version: ${String(value.schema_version)}`);
  }
  requiredString(value.mutation_id, 'mutation_id');
  if (!isRecord(value.actor)) throw new TenboContractError('invalid_request', 'actor must be an object');
  requiredString(value.actor.id, 'actor.id');
  if (!['user', 'agent', 'system'].includes(String(value.actor.type))) {
    throw new TenboContractError('invalid_request', 'actor.type must be user, agent, or system');
  }
  if (!isRecord(value.command)) throw new TenboContractError('invalid_request', 'command must be an object');
  requiredString(value.command.kind, 'command.kind');
  return value as unknown as CommandEnvelopeDto;
}

/** Runtime schema guard used at HTTP boundaries. Command-specific validation remains in its owning small port. */
export function parseQueryEnvelope(value: unknown): QueryEnvelopeDto {
  if (!isRecord(value)) throw new TenboContractError('invalid_request', 'query request must be an object');
  if (value.schema_version !== TENBO_SCHEMA_VERSION) {
    throw new TenboContractError('invalid_request', `unsupported schema_version: ${String(value.schema_version)}`);
  }
  if (!isRecord(value.query)) throw new TenboContractError('invalid_request', 'query must be an object');
  requiredString(value.query.kind, 'query.kind');
  return value as unknown as QueryEnvelopeDto;
}

export function normalizedPage(page: PageRequestDto | undefined): Required<Pick<PageRequestDto, 'limit'>> & Pick<PageRequestDto, 'cursor'> {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(page?.limit ?? DEFAULT_PAGE_SIZE)));
  return { limit, ...(page?.cursor ? { cursor: page.cursor } : {}) };
}
