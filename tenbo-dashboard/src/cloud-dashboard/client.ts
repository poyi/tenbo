import { BrowserTenboClient } from '../clients/BrowserTenboClient';
import {
  DEFAULT_PAGE_SIZE,
  TENBO_SCHEMA_VERSION,
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  type ItemClaimDto,
  type ActiveClaimPageDto,
  type ContextResultDto,
  type DocumentSearchResultDto,
  type DocumentPromotionAttemptDto,
  type DocumentVersionDto,
  type ItemFiltersDto,
  type ItemPageDto,
  type ItemRecordDto,
  type MutationHistoryEntryDto,
  type PageRequestDto,
  type PlanningDocumentKind,
  type ProjectPageDto,
  type TenboCommand,
  type TenboCommandResult,
  type TenboDocumentDto,
  type TenboQuery,
  type TenboQueryResult,
} from '../contracts/tenbo';

export const DASHBOARD_ITEM_PAGE_SIZE = 50;
export const DASHBOARD_AUX_PAGE_SIZE = 30;

export interface HumanSessionIdentity {
  userId: string;
  accessToken: string;
}

export class CloudDashboardClient {
  private readonly gateway: BrowserTenboClient;

  constructor(
    endpoint: string,
    apiKey: string,
    private readonly getIdentity: () => HumanSessionIdentity | null,
    fetchImpl?: typeof fetch,
  ) {
    this.gateway = new BrowserTenboClient({
      mode: 'cloud',
      endpoint,
      apiKey,
      credential: () => {
        const identity = this.requireIdentity();
        return { type: 'human', jwt: identity.accessToken };
      },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async listProjects(page: PageRequestDto = {}): Promise<ProjectPageDto> {
    const result = await this.query({ kind: 'listProjects', page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE) });
    if (result.kind !== 'projectPage') throw unexpected('projectPage', result);
    return result.value;
  }

  async listItems(projectId: string, filters: ItemFiltersDto, page: PageRequestDto = {}): Promise<ItemPageDto> {
    const result = await this.query({
      kind: 'listItems',
      filters,
      page: boundedPage(page, DASHBOARD_ITEM_PAGE_SIZE),
      projection: 'summary',
    }, projectId);
    if (result.kind !== 'itemPage') throw unexpected('itemPage', result);
    return result.value;
  }

  async getItem(projectId: string, itemId: string): Promise<ItemRecordDto> {
    const result = await this.query({ kind: 'getItem', item_id: itemId, include_archived: true }, projectId);
    if (result.kind !== 'item') throw unexpected('item', result);
    return result.value;
  }

  async getItemClaim(projectId: string, itemId: string): Promise<ItemClaimDto | null> {
    const result = await this.query({ kind: 'getItemClaim', item_id: itemId }, projectId);
    if (result.kind !== 'claim') throw unexpected('claim', result);
    return result.value;
  }

  async listActiveClaims(projectId: string, page: PageRequestDto = {}): Promise<ActiveClaimPageDto> {
    const result = await this.query({ kind: 'listActiveClaims', page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE) }, projectId);
    if (result.kind !== 'activeClaimPage') throw unexpected('activeClaimPage', result);
    return result.value;
  }

  async history(projectId: string, itemId?: string, page: PageRequestDto = {}) {
    const result = await this.query({ kind: 'getMutationHistory', ...(itemId ? { item_id: itemId } : {}), page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE) }, projectId);
    if (result.kind !== 'mutationHistory') throw unexpected('mutationHistory', result);
    return { entries: result.value as MutationHistoryEntryDto[], page: result.page };
  }

  async searchDocuments(projectId: string, search: string, kind: PlanningDocumentKind | undefined, page: PageRequestDto = {}) {
    const result = await this.query({
      kind: 'searchDocuments', query: search,
      ...(kind ? { kind_filter: kind } : {}),
      page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE),
    }, projectId);
    if (result.kind !== 'documentPage') throw unexpected('documentPage', result);
    return { documents: result.value as DocumentSearchResultDto[], page: result.page };
  }

  async getDocument(projectId: string, documentId: string): Promise<TenboDocumentDto> {
    const result = await this.query({ kind: 'getDocument', document_id: documentId }, projectId);
    if (result.kind !== 'document') throw unexpected('document', result);
    return result.value;
  }

  async getItemContext(projectId: string, itemId: string, options: {
    documentMode?: 'summary' | 'section' | 'full';
    section?: string;
    continuationCursor?: string;
  } = {}): Promise<ContextResultDto> {
    const result = await this.query({
      kind: 'getItemContext', item_id: itemId,
      ...(options.documentMode ? { document_mode: options.documentMode } : {}),
      ...(options.section ? { section: options.section } : {}),
      ...(options.continuationCursor ? { continuation_cursor: options.continuationCursor } : {}),
    }, projectId);
    if (result.kind !== 'context') throw unexpected('context', result);
    return result;
  }

  async getDocumentVersions(projectId: string, documentId: string, page: PageRequestDto = {}) {
    const result = await this.query({
      kind: 'getDocumentVersions', document_id: documentId,
      page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE),
    }, projectId);
    if (result.kind !== 'documentVersionPage') throw unexpected('documentVersionPage', result);
    return { versions: result.value as DocumentVersionDto[], page: result.page };
  }

  async compareDocumentVersions(projectId: string, documentId: string, fromVersion: string, toVersion: string) {
    const result = await this.query({
      kind: 'compareDocumentVersions', document_id: documentId,
      from_version: fromVersion, to_version: toVersion,
    }, projectId);
    if (result.kind !== 'documentDiff') throw unexpected('documentDiff', result);
    return result.value;
  }

  async listDocumentPromotions(projectId: string, filters: {
    itemId?: string;
    documentId?: string;
    attemptId?: string;
  }, page: PageRequestDto = {}) {
    const result = await this.query({
      kind: 'listDocumentPromotions',
      ...(filters.itemId ? { item_id: filters.itemId } : {}),
      ...(filters.documentId ? { document_id: filters.documentId } : {}),
      ...(filters.attemptId ? { attempt_id: filters.attemptId } : {}),
      page: boundedPage(page, DASHBOARD_AUX_PAGE_SIZE),
    }, projectId);
    if (result.kind !== 'promotionPage') throw unexpected('promotionPage', result);
    return { promotions: result.value as DocumentPromotionAttemptDto[], page: result.page };
  }

  async command(projectId: string, command: TenboCommand): Promise<TenboCommandResult> {
    const identity = this.requireIdentity();
    return this.gateway.command({
      schema_version: TENBO_SCHEMA_VERSION,
      client_version: TENBO_CLIENT_VERSION,
      backend_epoch: TENBO_BACKEND_EPOCH,
      project_id: projectId,
      mutation_id: crypto.randomUUID(),
      actor: { id: identity.userId, type: 'user' },
      command,
    });
  }

  private query(query: TenboQuery, projectId?: string): Promise<TenboQueryResult> {
    return this.gateway.query({
      schema_version: TENBO_SCHEMA_VERSION,
      client_version: TENBO_CLIENT_VERSION,
      backend_epoch: TENBO_BACKEND_EPOCH,
      ...(projectId ? { project_id: projectId } : {}),
      query,
    });
  }

  private requireIdentity(): HumanSessionIdentity {
    const identity = this.getIdentity();
    if (!identity) throw new Error('Your Tenbo session has expired. Sign in again.');
    return identity;
  }
}

export function boundedPage(page: PageRequestDto, fallback = DEFAULT_PAGE_SIZE): PageRequestDto {
  return { ...(page.cursor ? { cursor: page.cursor } : {}), limit: Math.min(fallback, Math.max(1, Math.floor(page.limit ?? fallback))) };
}

function unexpected(expected: string, result: TenboQueryResult): Error {
  return new Error(`Tenbo returned ${result.kind}; expected ${expected}.`);
}

/** Prevent a late response from a previously selected project replacing current state. */
export class ProjectResponseGuard {
  private revision = 0;
  private projectId = '';

  select(projectId: string): number {
    if (projectId !== this.projectId) {
      this.projectId = projectId;
      this.revision += 1;
    }
    return this.revision;
  }

  isCurrent(projectId: string, revision: number): boolean {
    return projectId === this.projectId && revision === this.revision;
  }
}
