import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Item } from '../types';
import { readJournal } from '../api/lib/hub/journal';
import {
  readCrossCuttingRoadmap,
  readCrossCuttingRoadmapArchive,
  readGeneratedCacheFile,
  readRoadmap,
  readRoadmapArchive,
  readWorkspace,
} from '../api/lib/tenboFs';

export const CLOUD_ROADMAP_MANIFEST_FORMAT = 'tenbo-cloud-roadmap-v1' as const;

export interface MigrationItem extends Item {
  scope_id: string;
  position: number;
  row_version: number;
  archived: boolean;
}

export interface MigrationRelation {
  source_item_id: string;
  target_item_id: string;
  relation_type: 'spawned_from' | 'related' | 'supersedes';
  metadata: { unresolved_legacy?: true };
}

export interface MigrationPlanningDocument {
  id: string;
  item_id: string;
  kind: 'spec' | 'workpad' | 'handoff';
  path: string;
  content: string;
  content_hash: string;
  archived: boolean;
}

export interface MigrationMutation {
  mutation_id: string;
  actor: string;
  timestamp: string;
  item_id: string;
  operation: string;
  request_hash: string;
  result?: unknown;
  /** Recovery-only exact mutation record; roadmap manifests omit it. */
  recovery_record?: {
    mutation_id: string;
    request_hash: string;
    actor_type: string;
    actor_id: string;
    command_name: string;
    request_body: unknown;
    result_json: unknown;
    entity_type: string | null;
    entity_id: string | null;
    committed_project_version: number;
    committed_entity_version: number | null;
    audit_metadata: Record<string, unknown>;
    created_at: string;
  };
}

export interface MigrationClaim {
  item_id: string;
  owner: string;
  fencing_token: number;
  version: number;
  expires_at: string;
}

export interface CloudRoadmapManifest {
  format: typeof CLOUD_ROADMAP_MANIFEST_FORMAT;
  schema_version: 1;
  source: { repository: string; commit_sha: string; hashes: Record<string, string> };
  counts: { items: number; active_items: number; archived_items: number; relations: number; documents: number; mutations: number; claims: number };
  item_ids: string[];
  items: MigrationItem[];
  relations: MigrationRelation[];
  documents: MigrationPlanningDocument[];
  mutations: MigrationMutation[];
  claims: MigrationClaim[];
  canonical_hash: string;
}

export function buildCloudRoadmapManifest(repoRoot: string): CloudRoadmapManifest {
  const workspace = readWorkspace(repoRoot);
  const items: MigrationItem[] = [];
  addItems(items, 'cross-cutting', readCrossCuttingRoadmap(repoRoot), false);
  addItems(items, 'cross-cutting', readCrossCuttingRoadmapArchive(repoRoot), true);
  for (const scope of workspace.scopeRefs) {
    addItems(items, scope.id, readRoadmap(repoRoot, scope.id), false);
    addItems(items, scope.id, readRoadmapArchive(repoRoot, scope.id), true);
  }
  items.sort(compareItems);
  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) throw new Error('roadmap contains duplicate item IDs across active/archive scopes');

  const relations = buildRelations(items, itemIds);
  const documents = collectPlanningDocuments(repoRoot, itemIds);
  const mutations = readJournal(repoRoot).map((event) => ({
    mutation_id: event.mutationId,
    actor: event.actor,
    timestamp: event.timestamp,
    item_id: event.itemId,
    operation: event.operation,
    request_hash: event.requestHash ?? sha256(stableJson({
      mutation_id: event.mutationId, actor: event.actor, timestamp: event.timestamp,
      item_id: event.itemId, operation: event.operation,
    })),
    ...(event.result !== undefined ? { result: event.result } : {}),
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.mutation_id.localeCompare(b.mutation_id));
  const claims = readClaims(repoRoot, itemIds);
  const sourceFiles = sourceFilePaths(repoRoot, workspace.scopeRefs.map((scope) => scope.id), documents.map((document) => document.path));
  const hashes = Object.fromEntries(sourceFiles.map((file) => [file, sha256(readFileSync(path.join(repoRoot, ...file.split('/'))))]));
  const source = {
    repository: git(repoRoot, ['config', '--get', 'remote.origin.url']).trim(),
    commit_sha: git(repoRoot, ['rev-parse', 'HEAD']).trim().toLowerCase(),
    hashes,
  };
  const counts = {
    items: items.length,
    active_items: items.filter((item) => !item.archived).length,
    archived_items: items.filter((item) => item.archived).length,
    relations: relations.length,
    documents: documents.length,
    mutations: mutations.length,
    claims: claims.length,
  };
  const core = {
    format: CLOUD_ROADMAP_MANIFEST_FORMAT, schema_version: 1 as const, source, counts,
    item_ids: [...itemIds].sort(), items, relations, documents, mutations, claims,
  };
  return { ...core, canonical_hash: sha256(stableJson(core)) };
}

export function assertCloudRoadmapManifest(value: unknown): asserts value is CloudRoadmapManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('migration manifest must be an object');
  const row = value as Partial<CloudRoadmapManifest>;
  if (row.format !== CLOUD_ROADMAP_MANIFEST_FORMAT || row.schema_version !== 1) throw new Error('unsupported migration manifest format/schema');
  if (!Array.isArray(row.items) || !Array.isArray(row.relations) || !Array.isArray(row.documents) || !Array.isArray(row.mutations) || !Array.isArray(row.claims)) {
    throw new Error('migration manifest collections are missing');
  }
  const { canonical_hash: claimed, ...core } = row;
  if (typeof claimed !== 'string' || claimed !== sha256(stableJson(core))) throw new Error('migration manifest canonical_hash mismatch');
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function addItems(out: MigrationItem[], scopeId: string, rows: Item[], archived: boolean): void {
  rows.forEach((item, position) => out.push({ ...item, scope_id: scopeId, position, row_version: 1, archived }));
}

function compareItems(a: MigrationItem, b: MigrationItem): number {
  return a.scope_id.localeCompare(b.scope_id) || Number(a.archived) - Number(b.archived) || a.position - b.position || a.id.localeCompare(b.id);
}

function buildRelations(items: MigrationItem[], itemIds: Set<string>): MigrationRelation[] {
  const keyed = new Map<string, MigrationRelation>();
  const add = (source: string, target: string | undefined, relationType: MigrationRelation['relation_type']) => {
    if (!target) return;
    if (source === target) throw new Error(`item ${source} contains a self relationship`);
    const relation: MigrationRelation = {
      source_item_id: source, target_item_id: target, relation_type: relationType,
      metadata: itemIds.has(target) ? {} : { unresolved_legacy: true },
    };
    keyed.set(`${source}\0${target}\0${relationType}`, relation);
  };
  for (const item of items) {
    add(item.id, item.spawned_from, 'spawned_from');
    add(item.id, item.superseded_by, 'supersedes');
    for (const related of item.related ?? []) add(item.id, related, 'related');
  }
  return [...keyed.values()].sort((a, b) =>
    a.source_item_id.localeCompare(b.source_item_id) || a.relation_type.localeCompare(b.relation_type) || a.target_item_id.localeCompare(b.target_item_id));
}

function collectPlanningDocuments(repoRoot: string, itemIds: Set<string>): MigrationPlanningDocument[] {
  const roots: Array<{ directory: string; kind: MigrationPlanningDocument['kind'] }> = [
    { directory: '.tenbo/specs', kind: 'spec' },
    { directory: '.tenbo/workpads', kind: 'workpad' },
    { directory: '.tenbo/handoffs', kind: 'handoff' },
  ];
  const documents: MigrationPlanningDocument[] = [];
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, ...root.directory.split('/'));
    if (!existsSync(absoluteRoot)) continue;
    for (const absolute of markdownFiles(absoluteRoot)) {
      const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
      const content = readFileSync(absolute, 'utf8');
      const frontmatter = matter(content).data as Record<string, unknown>;
      const itemId = stringValue(frontmatter.tenbo_item) ?? stringValue(frontmatter.item);
      if (!itemId || !itemIds.has(itemId)) continue;
      documents.push({
        id: deterministicUuid(`${itemId}\0${relative}`), item_id: itemId, kind: root.kind,
        path: relative, content, content_hash: sha256(content), archived: relative.includes('/archive/'),
      });
    }
  }
  return documents.sort((a, b) => a.path.localeCompare(b.path));
}

function markdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files.sort();
}

function readClaims(repoRoot: string, itemIds: Set<string>): MigrationClaim[] {
  const raw = readGeneratedCacheFile(repoRoot, ['coordination', 'claims.json']);
  if (!raw) return [];
  try {
    const state = JSON.parse(raw) as { claims?: Record<string, MigrationClaim> };
    return Object.values(state.claims ?? {}).filter((claim) => itemIds.has(claim.item_id)).sort((a, b) => a.item_id.localeCompare(b.item_id));
  } catch { return []; }
}

function sourceFilePaths(repoRoot: string, scopes: string[], planningPaths: string[]): string[] {
  const candidates = [
    '.tenbo/roadmap.yaml', '.tenbo/roadmap-archive.yaml',
    ...scopes.flatMap((scope) => [`.tenbo/scopes/${scope}/roadmap.yaml`, `.tenbo/scopes/${scope}/roadmap-archive.yaml`]),
    ...planningPaths,
    ...filesBelow(repoRoot, '.tenbo/journal', '.json'),
    ...filesBelow(repoRoot, '.tenbo/cache/coordination', '.json'),
  ];
  return [...new Set(candidates)].filter((file) => {
    const absolute = path.join(repoRoot, ...file.split('/'));
    return existsSync(absolute) && statSync(absolute).isFile();
  }).sort();
}

function filesBelow(repoRoot: string, directory: string, suffix: string): string[] {
  const absolute = path.join(repoRoot, ...directory.split('/'));
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return filesBelow(repoRoot, relative, suffix);
    return entry.isFile() && entry.name.endsWith(suffix) ? [relative] : [];
  });
}

function deterministicUuid(value: string): string {
  const hex = sha256(value).slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function git(repoRoot: string, args: string[]): string {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`git ${args[0]} failed while building cloud manifest: ${String(error)}`); }
}
