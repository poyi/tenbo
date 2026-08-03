import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PageMetaDto, PageRequestDto, PlanningDocumentDto, PlanningDocumentKind } from '../../contracts/tenbo';
import { normalizedPage, TenboContractError } from '../../contracts/tenbo';
import { findItem, updateItemRichFields } from './roadmapStore';
import { assertLegacyRoadmapWritesAllowed } from '../../cloud/cloudProjectPointer';

function version(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!normalized) throw new TenboContractError('invalid_request', 'document slug must contain letters or numbers');
  return normalized;
}

function rootForKind(repoRoot: string, kind: PlanningDocumentKind): string {
  return path.join(repoRoot, '.tenbo', kind === 'spec' ? 'specs' : kind === 'workpad' ? 'workpads' : 'handoffs');
}

function relativeForCreate(itemId: string, kind: PlanningDocumentKind, requestedSlug?: string): string {
  if (kind === 'workpad') return `.tenbo/workpads/${itemId}.md`;
  const suffix = slug(requestedSlug ?? kind);
  const dir = kind === 'spec' ? 'specs' : 'handoffs';
  return `.tenbo/${dir}/${itemId}-${suffix}.md`;
}

function assertDocumentPath(repoRoot: string, documentId: string): string {
  if (!documentId.startsWith('.tenbo/') || documentId.includes('..') || !documentId.endsWith('.md')) {
    throw new TenboContractError('invalid_request', `invalid planning document id: ${documentId}`);
  }
  const absolute = path.resolve(repoRoot, documentId);
  const tenboRoot = `${path.resolve(repoRoot, '.tenbo')}${path.sep}`;
  if (!absolute.startsWith(tenboRoot)) throw new TenboContractError('invalid_request', 'planning document escaped .tenbo');
  return absolute;
}

function metadataFromPath(documentId: string): { kind: PlanningDocumentKind; archived: boolean } {
  const archived = documentId.split('/').includes('archive');
  if (documentId.startsWith('.tenbo/specs/')) return { kind: 'spec', archived };
  if (documentId.startsWith('.tenbo/workpads/')) return { kind: 'workpad', archived };
  if (documentId.startsWith('.tenbo/handoffs/')) return { kind: 'handoff', archived };
  throw new TenboContractError('invalid_request', `unsupported planning document path: ${documentId}`);
}

function itemIdFromContentOrName(content: string, documentId: string): string {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const value = frontmatter.match(/^(?:tenbo_item|item):\s*(\S+)\s*$/m)?.[1];
  return value ?? path.basename(documentId).match(/^([a-z][a-z0-9-]*-\d+)/i)?.[1] ?? '';
}

function ensureFrontmatter(content: string, itemId: string, kind: PlanningDocumentKind): string {
  if (/^---\r?\n/.test(content)) return content;
  const field = kind === 'workpad' ? 'item' : 'tenbo_item';
  return `---\n${field}: ${itemId}\n---\n\n${content}`;
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, filePath);
}

export function getPlanningDocument(repoRoot: string, documentId: string): PlanningDocumentDto {
  const absolute = assertDocumentPath(repoRoot, documentId);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new TenboContractError('not_found', `planning document ${documentId} not found`);
  }
  const content = readFileSync(absolute, 'utf8');
  const meta = metadataFromPath(documentId);
  return {
    id: documentId,
    item_id: itemIdFromContentOrName(content, documentId),
    source_kind: 'planning',
    kind: meta.kind,
    path: documentId,
    content,
    version: version(content),
    archived: meta.archived,
  };
}

function attachDocumentToItem(repoRoot: string, itemId: string, kind: PlanningDocumentKind, documentPath: string): void {
  const located = findItem(repoRoot, itemId, true);
  if (located.archived) return;
  if (kind === 'workpad') {
    updateItemRichFields(repoRoot, itemId, { workpad: documentPath });
    return;
  }
  const links = located.item.links ?? [];
  updateItemRichFields(repoRoot, itemId, { links: links.includes(documentPath) ? links : [...links, documentPath] });
}

function replaceDocumentPathOnItem(repoRoot: string, itemId: string, kind: PlanningDocumentKind, before: string, after: string): void {
  const located = findItem(repoRoot, itemId, true);
  if (located.archived) return;
  if (kind === 'workpad') {
    if (located.item.workpad === before) updateItemRichFields(repoRoot, itemId, { workpad: after });
    return;
  }
  if (located.item.links?.includes(before)) {
    updateItemRichFields(repoRoot, itemId, { links: located.item.links.map((entry) => entry === before ? after : entry) });
  }
}

export function createPlanningDocument(
  repoRoot: string,
  itemId: string,
  kind: PlanningDocumentKind,
  content: string,
  requestedSlug?: string,
): PlanningDocumentDto {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  findItem(repoRoot, itemId);
  const documentId = relativeForCreate(itemId, kind, requestedSlug);
  const absolute = assertDocumentPath(repoRoot, documentId);
  if (existsSync(absolute)) throw new TenboContractError('conflict', `planning document ${documentId} already exists`);
  atomicWrite(absolute, ensureFrontmatter(content, itemId, kind));
  attachDocumentToItem(repoRoot, itemId, kind, documentId);
  return getPlanningDocument(repoRoot, documentId);
}

export function updatePlanningDocument(
  repoRoot: string,
  documentId: string,
  content: string,
  expectedVersion?: string,
): PlanningDocumentDto {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  const current = getPlanningDocument(repoRoot, documentId);
  if (expectedVersion && current.version !== expectedVersion) {
    throw new TenboContractError('conflict', `planning document ${documentId} changed since it was read`);
  }
  atomicWrite(assertDocumentPath(repoRoot, documentId), ensureFrontmatter(content, current.item_id, current.kind));
  return getPlanningDocument(repoRoot, documentId);
}

function movePlanningDocument(repoRoot: string, documentId: string, archive: boolean, expectedVersion?: string): PlanningDocumentDto {
  assertLegacyRoadmapWritesAllowed(repoRoot);
  const current = getPlanningDocument(repoRoot, documentId);
  if (expectedVersion && current.version !== expectedVersion) {
    throw new TenboContractError('conflict', `planning document ${documentId} changed since it was read`);
  }
  if (current.archived === archive) return current;
  const dir = path.posix.dirname(documentId);
  const filename = path.posix.basename(documentId);
  const nextId = archive
    ? `${dir}/archive/${filename}`
    : documentId.replace('/archive/', '/');
  const source = assertDocumentPath(repoRoot, documentId);
  const destination = assertDocumentPath(repoRoot, nextId);
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) throw new TenboContractError('conflict', `planning document ${nextId} already exists`);
  renameSync(source, destination);
  replaceDocumentPathOnItem(repoRoot, current.item_id, current.kind, documentId, nextId);
  return getPlanningDocument(repoRoot, nextId);
}

export function archivePlanningDocument(repoRoot: string, documentId: string, expectedVersion?: string): PlanningDocumentDto {
  return movePlanningDocument(repoRoot, documentId, true, expectedVersion);
}

export function restorePlanningDocument(repoRoot: string, documentId: string, expectedVersion?: string): PlanningDocumentDto {
  return movePlanningDocument(repoRoot, documentId, false, expectedVersion);
}

function walkMarkdown(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const absolute = path.join(dir, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) walkMarkdown(absolute, out);
    else if (stat.isFile() && entry.endsWith('.md')) out.push(absolute);
  }
}

export function searchPlanningDocuments(
  repoRoot: string,
  query: string,
  kindFilter?: PlanningDocumentKind,
  pageRequest?: PageRequestDto,
): { documents: PlanningDocumentDto[]; page: PageMetaDto } {
  const kinds: PlanningDocumentKind[] = kindFilter ? [kindFilter] : ['spec', 'workpad', 'handoff'];
  const files: string[] = [];
  for (const kind of kinds) walkMarkdown(rootForKind(repoRoot, kind), files);
  const needle = query.toLowerCase();
  const matches = files
    .map((absolute) => path.relative(repoRoot, absolute).split(path.sep).join('/'))
    .map((documentId) => getPlanningDocument(repoRoot, documentId))
    .filter((document) => !needle || `${document.path}\n${document.content}`.toLowerCase().includes(needle))
    .sort((a, b) => a.path.localeCompare(b.path));
  const page = normalizedPage(pageRequest);
  const offset = page.cursor?.startsWith('o:') ? Number(page.cursor.slice(2)) : 0;
  const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
  const documents = matches.slice(safeOffset, safeOffset + page.limit);
  const nextOffset = safeOffset + documents.length;
  return {
    documents,
    page: {
      row_count: documents.length,
      has_more: nextOffset < matches.length,
      ...(nextOffset < matches.length ? { next_cursor: `o:${nextOffset}` } : {}),
    },
  };
}
