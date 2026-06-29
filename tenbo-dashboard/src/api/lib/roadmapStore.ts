import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, isMap, isSeq, type Document } from 'yaml';
import { readState } from './tenboFs';
import { invalidate as invalidateCache } from './parseCache';
import { validate } from './validator';
import { comparePriority } from './priority';
import { normalizeNotes } from './notes';
import type { Item, Priority, Status, VerificationStatus, ValidateResult } from '../../types';

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
}

interface RoadmapFileRef {
  scopeId: string;
  filePath: string;
  items: Item[];
}

interface MutationOptions {
  beforeWrite?: () => void;
}

const STATUSES: readonly Status[] = ['now', 'next', 'later', 'done', 'dropped'];
const VERIFICATION_STATUSES: readonly VerificationStatus[] = ['not_required', 'pending_live', 'verified', 'failed'];

function tenboDir(repoRoot: string): string {
  return path.join(repoRoot, '.tenbo');
}

function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function readRoadmapRefs(repoRoot: string): RoadmapFileRef[] {
  const state = readState(repoRoot);
  const refs: RoadmapFileRef[] = state.scopes.map((scope) => ({
    scopeId: scope.id,
    filePath: path.join(tenboDir(repoRoot), 'scopes', scope.id, 'roadmap.yaml'),
    items: scope.items,
  }));
  const crossFile = path.join(tenboDir(repoRoot), 'roadmap.yaml');
  if (existsSync(crossFile)) {
    refs.push({
      scopeId: 'cross-cutting',
      filePath: crossFile,
      items: state.crossCuttingRoadmap ?? [],
    });
  }
  return refs;
}

function findRef(repoRoot: string, itemId: string): { ref: RoadmapFileRef; item: Item } {
  for (const ref of readRoadmapRefs(repoRoot)) {
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
  const { ref, item } = findRef(repoRoot, itemId);
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

export function findItem(repoRoot: string, itemId: string): LocatedItem {
  const { ref, item } = findRef(repoRoot, itemId);
  return { scopeId: ref.scopeId, filePath: ref.filePath, item };
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
  return mutateItem(repoRoot, itemId, (item) => {
    const existing = normalizeNotes(item.notes);
    const prefix = existing.length > 0 ? `${existing}\n` : '';
    return { notes: `${prefix}- ${date}: ${note}` };
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
  return mutateItem(repoRoot, itemId, (item) => {
    const existingNotes = normalizeNotes(item.notes);
    const evidenceText = opts.evidence.length ? opts.evidence.join('; ') : 'No evidence supplied';
    const note = `- ${date}: Completed with evidence: ${evidenceText}`;
    const links = item.links ?? [];
    const commitLink = opts.commit ? `commit:${opts.commit}` : undefined;
    return {
      status: 'done',
      notes: existingNotes ? `${existingNotes}\n${note}` : note,
      verification: {
        status,
        updated_at: updatedAt,
        ...(opts.evidence.length ? { evidence: opts.evidence } : {}),
      },
      ...(opts.docUpdate ? { doc_update: opts.docUpdate } : {}),
      ...(commitLink ? { links: links.includes(commitLink) ? links : [...links, commitLink] } : {}),
    };
  }, opts);
}

export function listItems(repoRoot: string, filters: ListItemFilters = {}): LocatedItem[] {
  const out: LocatedItem[] = [];
  const statuses = Array.isArray(filters.status) ? filters.status : filters.status ? [filters.status] : [];
  for (const ref of readRoadmapRefs(repoRoot)) {
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
      out.push({ scopeId: ref.scopeId, filePath: ref.filePath, item });
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
