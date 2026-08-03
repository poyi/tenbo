import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, isMap, isSeq, type Document } from 'yaml';
import {
  readCrossCuttingRoadmap,
  readRoadmap,
  readRoadmapArchive,
  readState,
  readWorkspace,
} from './tenboFs';
import { invalidate as invalidateCache } from './parseCache';
import { validate } from './validator';
import { comparePriority } from './priority';
import { normalizeNotes } from './notes';
import type { Item, Priority, Status, VerificationStatus, ValidateResult } from '../../types';
import { assertLegacyRoadmapWritesAllowed } from '../../cloud/cloudProjectPointer';

export type RoadmapErrorCode = 'not_found' | 'conflict' | 'invalid_status' | 'invalid_args';

export class RoadmapStoreError extends Error {
  code: RoadmapErrorCode;
  retryable: boolean;

  constructor(code: RoadmapErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'RoadmapStoreError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface LocatedItem {
  scopeId: string;
  filePath: string;
  item: Item;
  archived?: boolean;
}

export interface WriteResult {
  scopeId: string;
  filePath: string;
  item: Item;
  validation: ValidateResult;
}

export interface ListItemFilters {
  status?: Status | Status[];
  verification?: VerificationStatus;
  goal?: string;
  type?: Item['type'];
  priority?: Priority;
  layer?: string;
  scopeId?: string;
  archived?: boolean;
  search?: string;
}

interface RoadmapFileRef {
  scopeId: string;
  filePath: string;
  items: Item[];
  archived: boolean;
}

export interface MutationOptions {
  beforeWrite?: () => void;
  /**
   * Resolved agent identity (see hub/identity.ts) attributing this mutation.
   * When present, note text and verification evidence are stamped with it;
   * when absent (internal/system callers, or older call sites that predate
   * td-030), behavior is unchanged from before attribution existed.
   */
  actor?: string;
  /** Opaque item version returned by the query contract. */
  expectedVersion?: string;
}

const STATUSES: readonly Status[] = ['now', 'next', 'later', 'done', 'dropped'];
const VERIFICATION_STATUSES: readonly VerificationStatus[] = ['not_required', 'pending_live', 'verified', 'failed'];

function tenboDir(repoRoot: string): string {
  return path.join(repoRoot, '.tenbo');
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function itemVersion(item: Item): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

export function listVersion(items: Item[]): string {
  return createHash('sha256').update(JSON.stringify(items.map((item) => item.id))).digest('hex');
}

function readRoadmapRefs(repoRoot: string, includeArchived = false): RoadmapFileRef[] {
  // Lightweight path: reads only workspace.yaml plus the active roadmap files.
  // Do not replace this with readState(); agent item/list reads must not load
  // archives, narratives, metrics, specs, decisions, or workspace docs.
  const workspace = readWorkspace(repoRoot);
  const refs: RoadmapFileRef[] = workspace.scopeRefs.map((scope) => ({
    scopeId: scope.id,
    filePath: path.join(tenboDir(repoRoot), 'scopes', scope.id, 'roadmap.yaml'),
    items: readRoadmap(repoRoot, scope.id),
    archived: false,
  }));
  const crossFile = path.join(tenboDir(repoRoot), 'roadmap.yaml');
  if (existsSync(crossFile)) {
    refs.push({
      scopeId: 'cross-cutting',
      filePath: crossFile,
      items: readCrossCuttingRoadmap(repoRoot),
      archived: false,
    });
  }
  if (includeArchived) {
    for (const scope of workspace.scopeRefs) {
      const archiveFile = path.join(tenboDir(repoRoot), 'scopes', scope.id, 'roadmap-archive.yaml');
      if (!existsSync(archiveFile)) continue;
      refs.push({
        scopeId: scope.id,
        filePath: archiveFile,
        items: readRoadmapArchive(repoRoot, scope.id),
        archived: true,
      });
    }
    const crossArchiveFile = path.join(tenboDir(repoRoot), 'roadmap-archive.yaml');
    if (existsSync(crossArchiveFile)) {
      const data = getRoadmapItems(crossArchiveFile);
      refs.push({ scopeId: 'cross-cutting', filePath: crossArchiveFile, items: data, archived: true });
    }
  }
  return refs;
}

function getRoadmapItems(filePath: string): Item[] {
  const doc = parseRoadmap(readFileSync(filePath, 'utf8'));
  const value = doc.toJS() as { items?: Item[] } | null;
  return value?.items ?? [];
}

function findRef(repoRoot: string, itemId: string, includeArchived = false): { ref: RoadmapFileRef; item: Item } {
  for (const ref of readRoadmapRefs(repoRoot, includeArchived)) {
    const item = ref.items.find((candidate) => candidate.id === itemId);
    if (item) return { ref, item };
  }
  throw new RoadmapStoreError('not_found', `item ${itemId} not found`);
}

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
  invalidateCache(filePath);
}

function parseRoadmap(text: string): Document {
  return parseDocument(text, { keepSourceTokens: true });
}

function findItemNode(doc: Document, itemId: string) {
  const root = doc.contents;
  if (!isMap(root)) throw new RoadmapStoreError('invalid_args', 'roadmap root is not a map');
  const node = root.get('items', true);
  if (!isSeq(node)) throw new RoadmapStoreError('invalid_args', 'roadmap items is not a sequence');
  for (const item of node.items) {
    if (isMap(item) && item.get('id') === itemId) return item;
  }
  throw new RoadmapStoreError('not_found', `item ${itemId} not found`);
}

function validateStatus(status: string): Status {
  if ((STATUSES as readonly string[]).includes(status)) return status as Status;
  throw new RoadmapStoreError('invalid_status', `invalid status: ${status}`);
}

function validateVerificationStatus(status: string): VerificationStatus {
  if ((VERIFICATION_STATUSES as readonly string[]).includes(status)) return status as VerificationStatus;
  throw new RoadmapStoreError('invalid_status', `invalid verification status: ${status}`);
}

function mutateItem(
  repoRoot: string,
  itemId: string,
  patcher: (item: Item) => Partial<Item>,
  opts: MutationOptions = {},
): WriteResult {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  const { ref, item } = findRef(repoRoot, itemId);
  if (opts.expectedVersion && opts.expectedVersion !== itemVersion(item)) {
    throw new RoadmapStoreError('conflict', `item ${itemId} changed since it was read`, true);
  }
  const beforeText = readFileSync(ref.filePath, 'utf8');
  const beforeHash = hashText(beforeText);
  const doc = parseRoadmap(beforeText);
  const node = findItemNode(doc, itemId);
  const patch = patcher(item);

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      node.delete(key);
    } else {
      node.set(key, value);
    }
  }

  opts.beforeWrite?.();
  const currentHash = hashText(readFileSync(ref.filePath, 'utf8'));
  if (currentHash !== beforeHash) {
    throw new RoadmapStoreError('conflict', `roadmap changed while applying mutation to ${itemId}`, true);
  }

  atomicWrite(ref.filePath, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
  const state = readState(repoRoot);
  const validation = validate(state);
  const updated = findItem(repoRoot, itemId);
  return {
    scopeId: updated.scopeId,
    filePath: updated.filePath,
    item: updated.item,
    validation,
  };
}

export function findItem(repoRoot: string, itemId: string, includeArchived = false): LocatedItem & { archived: boolean } {
  const { ref, item } = findRef(repoRoot, itemId, includeArchived);
  return { scopeId: ref.scopeId, filePath: ref.filePath, item, archived: ref.archived };
}

/**
 * Build a `WriteResult` from the item's CURRENT on-disk state, without
 * mutating anything. Used by `applyMutation`'s idempotency check (td-030):
 * when a mutation id has already been journaled, the mutation already
 * landed on a prior attempt, so the correct "re-apply" response is simply
 * the current state, not a second write.
 */
export function currentWriteResult(repoRoot: string, itemId: string): WriteResult {
  const located = findItem(repoRoot, itemId);
  const validation = validate(readState(repoRoot));
  return { scopeId: located.scopeId, filePath: located.filePath, item: located.item, validation };
}

export function setItemStatus(repoRoot: string, itemId: string, status: Status | string, opts?: MutationOptions): WriteResult {
  const nextStatus = validateStatus(status);
  return mutateItem(repoRoot, itemId, () => ({ status: nextStatus }), opts);
}

export function addItemNote(
  repoRoot: string,
  itemId: string,
  note: string,
  opts: MutationOptions & { now?: () => Date } = {},
): WriteResult {
  const now = opts.now ?? (() => new Date());
  const date = now().toISOString().slice(0, 10);
  const stamp = opts.actor ? `${date} [${opts.actor}]` : date;
  return mutateItem(repoRoot, itemId, (item) => {
    const existing = normalizeNotes(item.notes);
    const prefix = existing.length > 0 ? `${existing}\n` : '';
    return { notes: `${prefix}- ${stamp}: ${note}` };
  }, opts);
}

export function setItemVerification(
  repoRoot: string,
  itemId: string,
  opts: MutationOptions & {
    status: VerificationStatus | string;
    evidence?: string[];
    note?: string;
    now?: () => Date;
  },
): WriteResult {
  const status = validateVerificationStatus(opts.status);
  const now = opts.now ?? (() => new Date());
  return mutateItem(repoRoot, itemId, () => ({
    verification: {
      status,
      updated_at: now().toISOString(),
      ...(opts.evidence && opts.evidence.length > 0 ? { evidence: opts.evidence } : {}),
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.actor ? { actor: opts.actor } : {}),
    },
  }), opts);
}

export function linkItemCommit(repoRoot: string, itemId: string, commit: string, opts?: MutationOptions): WriteResult {
  return mutateItem(repoRoot, itemId, (item) => {
    const link = `commit:${commit}`;
    const links = item.links ?? [];
    return { links: links.includes(link) ? links : [...links, link] };
  }, opts);
}

export function setItemDocUpdate(repoRoot: string, itemId: string, docUpdate: string, opts?: MutationOptions): WriteResult {
  return mutateItem(repoRoot, itemId, () => ({ doc_update: docUpdate }), opts);
}

export function completeItem(
  repoRoot: string,
  itemId: string,
  opts: MutationOptions & {
    evidence: string[];
    docUpdate?: string;
    commit?: string;
    verificationStatus?: VerificationStatus | string;
    now?: () => Date;
  },
): WriteResult {
  const now = opts.now ?? (() => new Date());
  const date = now().toISOString().slice(0, 10);
  const updatedAt = now().toISOString();
  const status = validateVerificationStatus(opts.verificationStatus ?? 'verified');
  const stamp = opts.actor ? `${date} [${opts.actor}]` : date;
  return mutateItem(repoRoot, itemId, (item) => {
    const existingNotes = normalizeNotes(item.notes);
    const evidenceText = opts.evidence.length ? opts.evidence.join('; ') : 'No evidence supplied';
    const note = `- ${stamp}: Completed with evidence: ${evidenceText}`;
    const links = item.links ?? [];
    const commitLink = opts.commit ? `commit:${opts.commit}` : undefined;
    return {
      status: 'done',
      notes: existingNotes ? `${existingNotes}\n${note}` : note,
      verification: {
        status,
        updated_at: updatedAt,
        ...(opts.evidence.length ? { evidence: opts.evidence } : {}),
        ...(opts.actor ? { actor: opts.actor } : {}),
      },
      ...(opts.docUpdate ? { doc_update: opts.docUpdate } : {}),
      ...(commitLink ? { links: links.includes(commitLink) ? links : [...links, commitLink] } : {}),
    };
  }, opts);
}

export type RichItemPatch = Partial<Pick<Item,
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
  | 'depends_on'
  | 'workpad'
  | 'doc_update'
  | 'dispatch_attempts'
  | 'bar_override'
>>;

export function updateItemRichFields(
  repoRoot: string,
  itemId: string,
  patch: RichItemPatch,
  opts: MutationOptions = {},
): WriteResult {
  if (Object.keys(patch).length === 0) {
    throw new RoadmapStoreError('invalid_args', 'rich item patch must include at least one field');
  }
  const allowed = new Set([
    'title', 'description', 'layer', 'layers', 'links', 'affects', 'done_when',
    'files_to_read', 'risks', 'type', 'priority', 'goal_ref', 'phases',
    'spawned_from', 'superseded_by', 'related', 'workpad', 'doc_update',
    'depends_on',
    'dispatch_attempts', 'bar_override',
  ]);
  const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RoadmapStoreError('invalid_args', `unsupported rich item field(s): ${unknown.join(', ')}`);
  }
  return mutateItem(repoRoot, itemId, () => patch, opts);
}

function roadmapPath(repoRoot: string, scopeId: string, archived = false): string {
  if (scopeId === 'cross-cutting') {
    return path.join(tenboDir(repoRoot), archived ? 'roadmap-archive.yaml' : 'roadmap.yaml');
  }
  return path.join(tenboDir(repoRoot), 'scopes', scopeId, archived ? 'roadmap-archive.yaml' : 'roadmap.yaml');
}

function itemSequence(doc: Document) {
  const root = doc.contents;
  if (!isMap(root)) throw new RoadmapStoreError('invalid_args', 'roadmap root is not a map');
  const node = root.get('items', true);
  if (!isSeq(node)) throw new RoadmapStoreError('invalid_args', 'roadmap items is not a sequence');
  return node;
}

export function createRoadmapItem(repoRoot: string, scopeId: string, item: Item): WriteResult {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  if (!item.id || !item.title || !item.description || !item.status) {
    throw new RoadmapStoreError('invalid_args', 'item id, title, description, and status are required');
  }
  if (!/^[a-z][a-z0-9-]*-\d{3,}(?:\.[a-z0-9]+)*$/i.test(item.id)) {
    throw new RoadmapStoreError('invalid_args', `new item id ${item.id} must use at least three digits`);
  }
  try {
    findRef(repoRoot, item.id, true);
    throw new RoadmapStoreError('conflict', `item ${item.id} already exists`);
  } catch (err) {
    if (!(err instanceof RoadmapStoreError) || err.code !== 'not_found') throw err;
  }

  const filePath = roadmapPath(repoRoot, scopeId);
  if (!existsSync(path.dirname(filePath))) {
    throw new RoadmapStoreError('invalid_args', `scope ${scopeId} does not exist`);
  }
  const beforeText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : 'items: []\n';
  const doc = parseRoadmap(beforeText);
  itemSequence(doc).add(item);
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') !== beforeText) {
    throw new RoadmapStoreError('conflict', `roadmap changed while creating ${item.id}`, true);
  }
  atomicWrite(filePath, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
  return currentWriteResult(repoRoot, item.id);
}

function removeItemFromDocument(doc: Document, itemId: string): Item {
  const seq = itemSequence(doc);
  const index = seq.items.findIndex((entry) => isMap(entry) && entry.get('id') === itemId);
  if (index < 0) throw new RoadmapStoreError('not_found', `item ${itemId} not found`);
  const item = ((doc.toJS() as { items?: Item[] } | null)?.items ?? []).find((entry) => entry.id === itemId);
  if (!item) throw new RoadmapStoreError('not_found', `item ${itemId} not found`);
  seq.delete(index);
  return item;
}

function appendItemToDocument(doc: Document, item: Item): void {
  const seq = itemSequence(doc);
  const duplicate = seq.items.some((entry) => isMap(entry) && entry.get('id') === item.id);
  if (duplicate) throw new RoadmapStoreError('conflict', `item ${item.id} already exists in destination`);
  seq.add(item);
}

function moveItemBetweenRoadmaps(
  repoRoot: string,
  itemId: string,
  source: RoadmapFileRef,
  destinationArchived: boolean,
  transform: (item: Item) => Item = (item) => item,
): void {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  const destinationPath = roadmapPath(repoRoot, source.scopeId, destinationArchived);
  const sourceText = readFileSync(source.filePath, 'utf8');
  const sourceDoc = parseRoadmap(sourceText);
  const destinationText = existsSync(destinationPath) ? readFileSync(destinationPath, 'utf8') : 'items: []\n';
  const destinationDoc = parseRoadmap(destinationText);
  const item = transform(removeItemFromDocument(sourceDoc, itemId));
  appendItemToDocument(destinationDoc, item);

  if (readFileSync(source.filePath, 'utf8') !== sourceText) {
    throw new RoadmapStoreError('conflict', `roadmap changed while moving ${itemId}`, true);
  }
  if (existsSync(destinationPath) && readFileSync(destinationPath, 'utf8') !== destinationText) {
    throw new RoadmapStoreError('conflict', `destination roadmap changed while moving ${itemId}`, true);
  }

  // Destination first makes a process crash recoverable as a duplicate rather
  // than silently losing the item between the two files.
  atomicWrite(destinationPath, destinationDoc.toString({ lineWidth: 0, blockQuote: 'literal' }));
  atomicWrite(source.filePath, sourceDoc.toString({ lineWidth: 0, blockQuote: 'literal' }));
}

export function archiveRoadmapItem(repoRoot: string, itemId: string, opts: MutationOptions = {}): LocatedItem & { archived: true } {
  const { ref, item } = findRef(repoRoot, itemId);
  if (opts.expectedVersion && opts.expectedVersion !== itemVersion(item)) {
    throw new RoadmapStoreError('conflict', `item ${itemId} changed since it was read`, true);
  }
  moveItemBetweenRoadmaps(repoRoot, itemId, ref, true);
  const moved = findItem(repoRoot, itemId, true);
  return { ...moved, archived: true };
}

export function reopenRoadmapItem(
  repoRoot: string,
  itemId: string,
  status: Exclude<Status, 'done' | 'dropped'> = 'next',
  opts: MutationOptions = {},
): WriteResult {
  const { ref, item } = findRef(repoRoot, itemId, true);
  if (opts.expectedVersion && opts.expectedVersion !== itemVersion(item)) {
    throw new RoadmapStoreError('conflict', `item ${itemId} changed since it was read`, true);
  }
  if (!ref.archived) return setItemStatus(repoRoot, itemId, status, opts);
  moveItemBetweenRoadmaps(repoRoot, itemId, ref, false, (value) => ({ ...value, status }));
  return currentWriteResult(repoRoot, itemId);
}

export function reorderRoadmapItems(
  repoRoot: string,
  scopeId: string,
  idsInOrder: string[],
  expectedListVersion?: string,
): { items: Item[]; version: string } {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  const filePath = roadmapPath(repoRoot, scopeId);
  const beforeText = readFileSync(filePath, 'utf8');
  const beforeItems = getRoadmapItems(filePath);
  if (expectedListVersion && expectedListVersion !== listVersion(beforeItems)) {
    throw new RoadmapStoreError('conflict', `roadmap list ${scopeId} changed since it was read`, true);
  }
  if (idsInOrder.length !== beforeItems.length || new Set(idsInOrder).size !== beforeItems.length) {
    throw new RoadmapStoreError('invalid_args', 'reorder must contain every active item id exactly once');
  }
  const beforeIds = new Set(beforeItems.map((item) => item.id));
  if (idsInOrder.some((id) => !beforeIds.has(id))) {
    throw new RoadmapStoreError('invalid_args', 'reorder contains an unknown item id');
  }
  const doc = parseRoadmap(beforeText);
  const seq = itemSequence(doc);
  const byId = new Map(seq.items.map((entry) => [isMap(entry) ? String(entry.get('id')) : '', entry]));
  seq.items = idsInOrder.map((id) => byId.get(id)).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (readFileSync(filePath, 'utf8') !== beforeText) {
    throw new RoadmapStoreError('conflict', `roadmap changed while reordering ${scopeId}`, true);
  }
  atomicWrite(filePath, doc.toString({ lineWidth: 0, blockQuote: 'literal' }));
  const items = getRoadmapItems(filePath);
  return { items, version: listVersion(items) };
}

export function listItems(repoRoot: string, filters: ListItemFilters = {}): LocatedItem[] {
  const out: LocatedItem[] = [];
  const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
  for (const ref of readRoadmapRefs(repoRoot, filters.archived === true)) {
    if (filters.archived !== undefined && ref.archived !== filters.archived) continue;
    if (filters.scopeId && ref.scopeId !== filters.scopeId) continue;
    for (const item of ref.items) {
      if (statuses.length > 0 && !statuses.includes(item.status)) continue;
      if (filters.verification && item.verification?.status !== filters.verification) continue;
      if (filters.type && item.type !== filters.type) continue;
      if (filters.priority && item.priority !== filters.priority) continue;
      if (filters.layer) {
        const layerRefs = [item.layer, ...(item.layers ?? []), ...(item.affects ?? [])].filter(Boolean);
        if (!layerRefs.includes(filters.layer)) continue;
      }
      if (filters.goal) {
        const goalRef = item.goal_ref;
        const matchesGoal = Array.isArray(goalRef) ? goalRef.includes(filters.goal) : goalRef === filters.goal;
        if (!matchesGoal) continue;
      }
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const haystack = `${item.id} ${item.title} ${item.description}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      out.push({ scopeId: ref.scopeId, filePath: ref.filePath, item, archived: ref.archived });
    }
  }
  return out;
}

export function listNextItems(repoRoot: string): LocatedItem[] {
  return listItems(repoRoot).filter(({ item }) => item.status === 'now' || item.status === 'next')
    .sort((a, b) => {
      const statusRank = (entry: LocatedItem) => entry.item.status === 'now' ? 0 : 1;
      return statusRank(a) - statusRank(b) || comparePriority(a.item, b.item);
    });
}

export function isRoadmapStoreError(err: unknown): err is RoadmapStoreError {
  return err instanceof RoadmapStoreError;
}

export function assertValidStatusForCli(status: string): Status {
  return validateStatus(status);
}

export function assertValidVerificationStatusForCli(status: string): VerificationStatus {
  return validateVerificationStatus(status);
}
