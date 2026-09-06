import { createHash } from 'node:crypto';
import {
  dispatchBackendCommand,
  dispatchBackendQuery,
} from '../../contracts/backendDispatcher';
import {
  type ActorDto,
  type CommandEnvelopeDto,
  type ContextResultDto,
  type ItemCommandPort,
  type ItemFiltersDto,
  type ItemPageDto,
  type ItemQueryPort,
  type ItemRecordDto,
  type JsonValue,
  type GitDocumentIngestPort,
  normalizedPage,
  parseCommandEnvelope,
  parseQueryEnvelope,
  type PlanningDocumentPort,
  type ProjectPort,
  type QueryEnvelopeDto,
  type TenboBackendPorts,
  type TenboCommand,
  type TenboCommandResult,
  TenboContractError,
  type TenboGatewayPort,
  type TenboQueryResult,
  type ContextQueryPort,
  type CoordinationPort,
} from '../../contracts/tenbo';
import {
  addItemNote,
  archiveRoadmapItem,
  completeItem,
  createRoadmapItem,
  findItem,
  itemVersion,
  linkItemCommit,
  listItems,
  listNextItems,
  reopenRoadmapItem,
  reorderRoadmapItems,
  setItemDocUpdate,
  setItemStatus,
  setItemVerification,
  updateItemRichFields,
  type LocatedItem,
  type WriteResult,
} from '../lib/roadmapStore';
import { allocateNextId } from '../lib/idAllocator';
import { resolveFeatureContext, resolveItemContext, resolveSessionContext } from '../lib/contextResolver';
import { assertLocalClaimFence, claimLocalItem, getActiveLocalClaim, releaseLocalClaim, renewLocalClaim } from '../lib/localClaimStore';
import { effectiveStatus } from '../lib/phases';
import {
  archivePlanningDocument,
  createPlanningDocument,
  getPlanningDocument,
  restorePlanningDocument,
  searchPlanningDocuments,
  updatePlanningDocument,
} from '../lib/planningDocumentStore';
import { readJournal, appendJournalEvent } from '../lib/hub/journal';
import { acquireMutationClaim } from '../lib/hub/mutationClaim';
import { readState } from '../lib/tenboFs';
import { validate } from '../lib/validator';

function dependencyProjection(repoRoot: string, located: LocatedItem): Pick<ItemRecordDto, 'depends_on' | 'unresolved_blockers' | 'readiness'> {
  const dependsOn = located.item.depends_on ?? [];
  const unresolved = dependsOn.map((itemId) => {
    try {
      const prerequisite = findItem(repoRoot, itemId, true);
      const status = effectiveStatus(prerequisite.item);
      return status === 'done' ? null : { item_id: itemId, status };
    } catch {
      return { item_id: itemId, status: 'missing' as const };
    }
  }).filter((value): value is NonNullable<typeof value> => value !== null);
  return { depends_on: dependsOn, unresolved_blockers: unresolved, readiness: unresolved.length === 0 ? 'ready' : 'blocked' };
}

function localSpecification(repoRoot: string, located: LocatedItem): ItemRecordDto['specification'] {
  const documentPath = located.item.links?.find((link) => link.startsWith('.tenbo/specs/') && !link.includes('/archive/'));
  if (!documentPath) return undefined;
  try {
    const document = getPlanningDocument(repoRoot, documentPath);
    return {
      id: document.id,
      item_id: document.item_id,
      source_kind: 'planning',
      kind: 'spec',
      path: document.path,
      version: document.version,
      archived: document.archived,
      content_hash: document.version,
      summary: document.content.replace(/\s+/g, ' ').trim().slice(0, 320),
      token_estimate: Math.ceil(document.content.length / 4),
      content_bytes: Buffer.byteLength(document.content),
    };
  } catch {
    return undefined;
  }
}

function record(repoRoot: string, located: LocatedItem, archived = located.archived ?? false): ItemRecordDto {
  const specification = localSpecification(repoRoot, located);
  return {
    scope_id: located.scopeId,
    item: located.item,
    version: itemVersion(located.item),
    archived,
    ...dependencyProjection(repoRoot, located),
    ...(specification ? { specification } : {}),
  };
}

function recordFromWrite(repoRoot: string, result: WriteResult): ItemRecordDto {
  return record(repoRoot, result);
}

function pageItems(repoRoot: string, located: LocatedItem[], requestedPage?: { cursor?: string; limit?: number }): ItemPageDto {
  const page = normalizedPage(requestedPage);
  const parsedOffset = page.cursor?.startsWith('o:') ? Number(page.cursor.slice(2)) : 0;
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
  const rows = located.slice(offset, offset + page.limit);
  const nextOffset = offset + rows.length;
  return {
    items: rows.map((entry) => record(repoRoot, entry)),
    page: {
      row_count: rows.length,
      has_more: nextOffset < located.length,
      ...(nextOffset < located.length ? { next_cursor: `o:${nextOffset}` } : {}),
    },
  };
}

function localFilters(filters: ItemFiltersDto | undefined) {
  return filters ? {
    status: filters.status,
    verification: filters.verification,
    goal: filters.goal,
    type: filters.type,
    priority: filters.priority,
    layer: filters.layer,
    scopeId: filters.scope_id,
    archived: filters.archived,
    search: filters.search,
  } : {};
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function dependencyReaches(repoRoot: string, startItemId: string, targetItemId: string): boolean {
  const pending = [startItemId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const itemId = pending.pop()!;
    if (itemId === targetItemId) return true;
    if (visited.has(itemId)) continue;
    visited.add(itemId);
    const item = findItem(repoRoot, itemId, true).item;
    pending.push(...(item.depends_on ?? []));
  }
  return false;
}

class LocalItemPort implements ItemQueryPort, ItemCommandPort {
  constructor(private readonly repoRoot: string) {}

  async listItems(filters?: ItemFiltersDto, page?: { cursor?: string; limit?: number }): Promise<ItemPageDto> {
    return pageItems(this.repoRoot, listItems(this.repoRoot, localFilters(filters)), page);
  }

  async getItem(itemId: string, includeArchived = false): Promise<ItemRecordDto> {
    const located = findItem(this.repoRoot, itemId, includeArchived);
    return record(this.repoRoot, located, located.archived);
  }

  async getWorkQueue(filters?: ItemFiltersDto, page?: { cursor?: string; limit?: number }): Promise<ItemPageDto> {
    const candidates = listNextItems(this.repoRoot).filter((entry) => {
      if (filters?.type && entry.item.type !== filters.type) return false;
      if (filters?.priority && entry.item.priority !== filters.priority) return false;
      if (filters?.layer && ![entry.item.layer, ...(entry.item.layers ?? []), ...(entry.item.affects ?? [])].includes(filters.layer)) return false;
      return dependencyProjection(this.repoRoot, entry).readiness === 'ready';
    });
    return pageItems(this.repoRoot, candidates, page);
  }

  async execute(command: Parameters<ItemCommandPort['execute']>[0], actor: ActorDto): Promise<TenboCommandResult> {
    const expected = 'expected_version' in command ? command.expected_version : undefined;
    switch (command.kind) {
      case 'allocateItemId':
        return { kind: 'allocation', item_id: allocateNextId({ repoRoot: this.repoRoot, prefix: command.prefix }) };
      case 'createItem': {
        const result = createRoadmapItem(this.repoRoot, command.scope_id, command.item);
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'updateRichFields': {
        const result = updateItemRichFields(this.repoRoot, command.item_id, command.patch, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'setStatus': {
        const result = setItemStatus(this.repoRoot, command.item_id, command.status, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'reorderItems': {
        const result = reorderRoadmapItems(this.repoRoot, command.scope_id, command.item_ids, command.expected_list_version);
        return { kind: 'reorder', scope_id: command.scope_id, item_ids: result.items.map((item) => item.id), list_version: result.version };
      }
      case 'archiveItem': {
        const located = archiveRoadmapItem(this.repoRoot, command.item_id, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: record(this.repoRoot, located, true), validation: validate(readState(this.repoRoot)) };
      }
      case 'reopenItem': {
        const result = reopenRoadmapItem(this.repoRoot, command.item_id, command.status, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'addNote': {
        const result = addItemNote(this.repoRoot, command.item_id, command.note, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'setVerification': {
        const result = setItemVerification(this.repoRoot, command.item_id, {
          status: command.status,
          evidence: command.evidence,
          note: command.note,
          expectedVersion: expected,
          actor: actor.id,
        });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'setDocUpdate': {
        const result = setItemDocUpdate(this.repoRoot, command.item_id, command.doc_update, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'linkCommit': {
        const result = linkItemCommit(this.repoRoot, command.item_id, command.commit, { expectedVersion: expected, actor: actor.id });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
      case 'completeItem': {
        const result = completeItem(this.repoRoot, command.item_id, {
          evidence: command.evidence,
          docUpdate: command.doc_update,
          commit: command.commit,
          verificationStatus: command.verification_status,
          expectedVersion: expected,
          actor: actor.id,
        });
        const completed = recordFromWrite(this.repoRoot, result);
        const newlyUnblocked = listItems(this.repoRoot).filter((entry) =>
          entry.item.depends_on?.includes(command.item_id)
          && dependencyProjection(this.repoRoot, entry).readiness === 'ready'
        ).map((entry) => entry.item.id);
        return { kind: 'item', value: completed, validation: result.validation, newly_unblocked: newlyUnblocked };
      }
      case 'addDependency':
      case 'removeDependency': {
        assertLocalClaimFence(this.repoRoot, command.item_id, command.fencing_token);
        findItem(this.repoRoot, command.prerequisite_id, true);
        const located = findItem(this.repoRoot, command.item_id);
        if (command.kind === 'addDependency') {
          if (effectiveStatus(located.item) === 'now' && !getActiveLocalClaim(this.repoRoot, command.item_id)) {
            throw new TenboContractError('conflict', `adding a dependency to active work ${command.item_id} requires a claim`);
          }
          if (dependencyReaches(this.repoRoot, command.prerequisite_id, command.item_id)) {
            throw new TenboContractError('conflict', `dependency ${command.item_id} -> ${command.prerequisite_id} would create a cycle`);
          }
        }
        const current = located.item.depends_on ?? [];
        const dependsOn = command.kind === 'addDependency'
          ? [...new Set([...current, command.prerequisite_id])]
          : current.filter((itemId) => itemId !== command.prerequisite_id);
        const result = updateItemRichFields(this.repoRoot, command.item_id, { depends_on: dependsOn }, {
          expectedVersion: expected,
          actor: actor.id,
        });
        return { kind: 'item', value: recordFromWrite(this.repoRoot, result), validation: result.validation };
      }
    }
  }
}

class LocalContextPort implements ContextQueryPort {
  constructor(private readonly repoRoot: string) {}

  async session(): Promise<ContextResultDto> {
    const bundle = resolveSessionContext(this.repoRoot);
    return { kind: 'context', intent: 'session', payload: jsonValue(bundle), bounds: bundle.bounds };
  }

  async feature(query: string): Promise<ContextResultDto> {
    const bundle = resolveFeatureContext(this.repoRoot, query);
    return { kind: 'context', intent: 'feature', payload: jsonValue(bundle), bounds: bundle.bounds };
  }

  async item(itemId: string): Promise<ContextResultDto> {
    const bundle = resolveItemContext(this.repoRoot, itemId);
    return { kind: 'context', intent: 'item', payload: jsonValue(bundle), bounds: bundle.bounds };
  }
}

class LocalCoordinationPort implements CoordinationPort {
  constructor(private readonly repoRoot: string) {}

  async execute(command: Parameters<CoordinationPort['execute']>[0]): Promise<TenboCommandResult> {
    switch (command.kind) {
      case 'claimItem': {
        const located = findItem(this.repoRoot, command.item_id);
        const projection = dependencyProjection(this.repoRoot, located);
        if (projection.readiness === 'blocked') {
          throw new TenboContractError('conflict', `item ${command.item_id} is blocked by ${projection.unresolved_blockers?.map((entry) => entry.item_id).join(', ')}`);
        }
        return { kind: 'claim', value: claimLocalItem(this.repoRoot, command.item_id, command.owner, command.lease_seconds) };
      }
      case 'renewClaim':
        return { kind: 'claim', value: renewLocalClaim(this.repoRoot, command.item_id, command.owner, command.fencing_token, command.lease_seconds) };
      case 'releaseClaim':
        releaseLocalClaim(this.repoRoot, command.item_id, command.owner, command.fencing_token);
        return { kind: 'claimReleased', item_id: command.item_id, fencing_token: command.fencing_token };
    }
  }
}

class LocalDocumentPort implements PlanningDocumentPort {
  constructor(private readonly repoRoot: string) {}

  async get(documentId: string) {
    return getPlanningDocument(this.repoRoot, documentId);
  }

  async search(query: string, kind: Parameters<PlanningDocumentPort['search']>[1], page?: Parameters<PlanningDocumentPort['search']>[2]) {
    return searchPlanningDocuments(this.repoRoot, query, kind, page);
  }

  async execute(command: Parameters<PlanningDocumentPort['execute']>[0]): Promise<TenboCommandResult> {
    const itemId = command.kind === 'createPlanningDocument'
      ? command.item_id
      : getPlanningDocument(this.repoRoot, command.document_id).item_id;
    const claim = getActiveLocalClaim(this.repoRoot, itemId);
    if (!claim) throw new TenboContractError('conflict', `document mutation requires an active claim for ${itemId}`);
    assertLocalClaimFence(this.repoRoot, itemId, command.fencing_token);
    switch (command.kind) {
      case 'createPlanningDocument':
        return { kind: 'document', value: createPlanningDocument(this.repoRoot, command.item_id, command.document_kind, command.content, command.slug) };
      case 'updatePlanningDocument':
        return { kind: 'document', value: updatePlanningDocument(this.repoRoot, command.document_id, command.content, command.expected_version) };
      case 'replacePlanningDocumentSection': {
        const current = getPlanningDocument(this.repoRoot, command.document_id);
        const content = editLocalMarkdownSection(current.content, command.heading, command.content, command.expected_section_hash, false);
        return { kind: 'document', value: updatePlanningDocument(this.repoRoot, command.document_id, content, command.expected_version) };
      }
      case 'appendPlanningDocumentSection': {
        const current = getPlanningDocument(this.repoRoot, command.document_id);
        const content = editLocalMarkdownSection(current.content, command.heading, command.content, undefined, true);
        return { kind: 'document', value: updatePlanningDocument(this.repoRoot, command.document_id, content, command.expected_version) };
      }
      case 'restorePlanningDocumentVersion':
        throw new TenboContractError('unsupported', 'local planning documents do not retain immutable cloud version history');
      case 'archivePlanningDocument':
        return { kind: 'document', value: archivePlanningDocument(this.repoRoot, command.document_id, command.expected_version) };
      case 'restorePlanningDocument':
        return { kind: 'document', value: restorePlanningDocument(this.repoRoot, command.document_id, command.expected_version) };
    }
  }
}

function editLocalMarkdownSection(
  content: string,
  requestedHeading: string,
  body: string,
  expectedHash: string | undefined,
  append: boolean,
): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const matches: Array<{ index: number; level: number }> = [];
  for (const [index, line] of lines.entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading && heading[2]!.trim().toLowerCase() === requestedHeading.trim().toLowerCase()) {
      matches.push({ index, level: heading[1]!.length });
    }
  }
  if (append) {
    if (matches.length > 0) throw new TenboContractError('conflict', `section ${requestedHeading} already exists`);
    return `${content.trimEnd()}\n\n## ${requestedHeading.trim()}\n\n${body.trimEnd()}\n`;
  }
  if (matches.length !== 1) {
    throw new TenboContractError(matches.length === 0 ? 'not_found' : 'conflict', `section ${requestedHeading} must occur exactly once`);
  }
  const start = matches[0]!;
  let end = lines.length;
  for (let index = start.index + 1; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[index]!);
    if (heading && heading[1]!.length <= start.level) { end = index; break; }
  }
  const section = lines.slice(start.index, end).join('\n');
  if (!expectedHash || createHash('sha256').update(section).digest('hex') !== expectedHash) {
    throw new TenboContractError('conflict', `section ${requestedHeading} changed since it was read`);
  }
  return [...lines.slice(0, start.index), lines[start.index]!, '', body.trimEnd(), ...lines.slice(end)].join('\n');
}

class LocalProjectPort implements ProjectPort {
  constructor(private readonly repoRoot: string) {}

  async history(itemId: string | undefined, page?: Parameters<ProjectPort['history']>[1]) {
    const all = readJournal(this.repoRoot, itemId ? { itemId } : {});
    const normalized = normalizedPage(page);
    const parsedOffset = normalized.cursor?.startsWith('o:') ? Number(normalized.cursor.slice(2)) : 0;
    const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? Math.floor(parsedOffset) : 0;
    const rows = all.slice(offset, offset + normalized.limit);
    const nextOffset = offset + rows.length;
    return {
      entries: rows.map((entry) => ({
        mutation_id: entry.mutationId,
        actor: entry.actor,
        timestamp: entry.timestamp,
        item_id: entry.itemId,
        operation: entry.operation,
      })),
      page: {
        row_count: rows.length,
        has_more: nextOffset < all.length,
        ...(nextOffset < all.length ? { next_cursor: `o:${nextOffset}` } : {}),
      },
    };
  }

  async getIdentity(): Promise<never> {
    throw new TenboContractError('unsupported', 'project identity is available only through a cloud backend');
  }

  async exportProject(): Promise<JsonValue> {
    return jsonValue(readState(this.repoRoot));
  }

  async importProject(): Promise<TenboCommandResult> {
    throw new TenboContractError('unsupported', 'local project import is implemented by the x-093 migration adapter');
  }

  async executeStagedImport(): Promise<TenboCommandResult> {
    throw new TenboContractError('unsupported', 'staged project import is available only through a cloud backend');
  }
}

class LocalGitDocumentIngestPort implements GitDocumentIngestPort {
  async execute(): Promise<TenboCommandResult> {
    throw new TenboContractError('unsupported', 'verified Git-document ingestion is available only through a cloud backend');
  }
}

function requestHash(request: CommandEnvelopeDto): string {
  return createHash('sha256').update(JSON.stringify(request.command)).digest('hex');
}

function targetItemId(command: TenboCommand, result: TenboCommandResult): string {
  if ('item_id' in command) return command.item_id;
  if (command.kind === 'updatePlanningDocument' || command.kind === 'archivePlanningDocument' || command.kind === 'restorePlanningDocument') {
    return result.kind === 'document' ? result.value.item_id : command.document_id;
  }
  if (result.kind === 'allocation') return result.item_id;
  if (result.kind === 'item') return result.value.item.id;
  return 'project';
}

/** Local filesystem implementation of the transport-neutral ports. */
export class LocalTenboBackend implements TenboGatewayPort {
  readonly ports: TenboBackendPorts;

  constructor(readonly repoRoot: string) {
    this.ports = {
      items: new LocalItemPort(repoRoot),
      context: new LocalContextPort(repoRoot),
      coordination: new LocalCoordinationPort(repoRoot),
      documents: new LocalDocumentPort(repoRoot),
      gitDocuments: new LocalGitDocumentIngestPort(),
      project: new LocalProjectPort(repoRoot),
    };
  }

  async query(raw: QueryEnvelopeDto): Promise<TenboQueryResult> {
    const request = parseQueryEnvelope(raw);
    return dispatchBackendQuery(this.ports, request);
  }

  async command(raw: CommandEnvelopeDto): Promise<TenboCommandResult> {
    const request = parseCommandEnvelope(raw);
    const hash = requestHash(request);
    const prior = readJournal(this.repoRoot, { mutationId: request.mutation_id })[0];
    if (prior) {
      if (prior.requestHash && prior.requestHash !== hash) {
        throw new TenboContractError('conflict', `mutation_id ${request.mutation_id} was reused with a different request`);
      }
      if (prior.result) return prior.result as TenboCommandResult;
      throw new TenboContractError('conflict', `mutation_id ${request.mutation_id} already belongs to a legacy mutation`);
    }

    const claim = acquireMutationClaim(this.repoRoot, request.mutation_id);
    if (!claim.shouldApply) {
      const completed = readJournal(this.repoRoot, { mutationId: request.mutation_id })[0];
      if (completed?.result) return completed.result as TenboCommandResult;
      throw new TenboContractError('conflict', `mutation ${request.mutation_id} is still in flight`);
    }

    const result = await dispatchBackendCommand(this.ports, request);
    try {
      appendJournalEvent(this.repoRoot, {
        mutationId: request.mutation_id,
        actor: request.actor.id,
        itemId: targetItemId(request.command, result),
        operation: request.command.kind,
        requestHash: hash,
        result,
      });
    } catch (err) {
      process.stderr.write(`warning: failed to journal typed mutation ${request.mutation_id} — ${String(err)}\n`);
    }
    return result;
  }
}
