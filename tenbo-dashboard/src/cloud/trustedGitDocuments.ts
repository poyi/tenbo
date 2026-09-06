import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ActorDto, ContextResultDto, GitDocumentDto, JsonValue, TenboBackendPorts } from '../contracts/tenbo';

export interface ExactCommitGitDocument {
  repository: string;
  commit_sha: string;
  path: string;
  document_kind: string;
  content_hash: string;
  content: string;
}

export interface DirtyGitDocumentOverlay extends ExactCommitGitDocument {
  source_kind: 'local_overlay';
  persisted: false;
  base_content_hash: string;
  deleted?: boolean;
}

export interface PromotionPatch {
  document_id: string;
  item_id: string;
  source_version: string;
  source_content_hash: string;
  target_repository: string;
  target_path: string;
  absolute_path: string;
}

export async function writeDocumentPromotionPatch(
  ports: TenboBackendPorts,
  repoRoot: string,
  documentId: string,
  targetPath: string,
): Promise<PromotionPatch> {
  const document = await ports.documents.get(documentId);
  if (document.source_kind !== 'planning') throw new Error('only a cloud planning document can be promoted');
  if (document.archived) throw new Error('restore the planning document before promoting it');
  const normalizedPath = normalizeGitPath(targetPath);
  const absolutePath = path.resolve(repoRoot, ...normalizedPath.split('/'));
  assertInsideRepository(repoRoot, absolutePath);
  if (existsSync(absolutePath)) throw new Error(`${normalizedPath} already exists; promotion never overwrites repository files`);
  const repository = gitText(repoRoot, ['config', '--get', 'remote.origin.url']).trim();
  if (!repository) throw new Error('Git remote.origin.url is required for promotion');
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, document.content, { encoding: 'utf8', flag: 'wx' });
  return {
    document_id: document.id,
    item_id: document.item_id,
    source_version: document.version,
    source_content_hash: sha256(Buffer.from(document.content, 'utf8')),
    target_repository: repository,
    target_path: normalizedPath,
    absolute_path: absolutePath,
  };
}

/** Roll back only the new file created by writeDocumentPromotionPatch. */
export function rollbackDocumentPromotionPatch(repoRoot: string, patch: PromotionPatch): void {
  assertInsideRepository(repoRoot, patch.absolute_path);
  if (existsSync(patch.absolute_path)) unlinkSync(patch.absolute_path);
}

export function readExactCommitGitDocument(
  repoRoot: string,
  commitSha: string,
  documentPath: string,
  expectedRepository?: string,
): ExactCommitGitDocument {
  const normalizedPath = normalizeGitPath(documentPath);
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new Error('commit must be a full hexadecimal commit SHA');
  const resolvedCommit = gitText(repoRoot, ['rev-parse', '--verify', `${commitSha}^{commit}`]).trim().toLowerCase();
  if (resolvedCommit !== commitSha.toLowerCase()) throw new Error(`commit ${commitSha} did not resolve exactly`);
  const repository = gitText(repoRoot, ['config', '--get', 'remote.origin.url']).trim();
  if (!repository) throw new Error('Git remote.origin.url is required for trusted ingestion');
  if (expectedRepository && canonicalRepository(repository) !== canonicalRepository(expectedRepository)) {
    throw new Error(`local Git origin does not match destination project repository (${repository} != ${expectedRepository})`);
  }
  const bytes = gitBytes(repoRoot, ['show', `${resolvedCommit}:${normalizedPath}`]);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`${normalizedPath} is not canonical UTF-8 text`);
  return {
    repository: expectedRepository ?? repository,
    commit_sha: resolvedCommit,
    path: normalizedPath,
    document_kind: documentKind(normalizedPath),
    content_hash: sha256(bytes),
    content,
  };
}

/**
 * The only ingestion helper exposed to CLI migration code. Content is always
 * obtained via `git show <full-sha>:<path>`; no content parameter exists.
 */
export async function ingestExactCommitGitDocument(
  ports: TenboBackendPorts,
  repoRoot: string,
  commitSha: string,
  documentPath: string,
  actor: ActorDto,
): Promise<GitDocumentDto> {
  const { repository } = await ports.project.getIdentity();
  if (typeof repository !== 'string' || !repository.trim()) throw new Error('cloud project identity did not include a non-empty repository');
  const document = readExactCommitGitDocument(repoRoot, commitSha, documentPath, repository);
  const result = await ports.gitDocuments.execute({ kind: 'ingestGitDocument', ...document }, actor);
  if (result.kind !== 'gitDocument') throw new Error(`expected gitDocument result, received ${result.kind}`);
  if (result.value.content_hash !== document.content_hash) throw new Error('cloud returned a different Git document hash');
  return result.value;
}

export function dirtyGitDocumentOverlay(
  repoRoot: string,
  commitSha: string,
  documentPath: string,
  expectedRepository?: string,
): DirtyGitDocumentOverlay | null {
  const base = readExactCommitGitDocument(repoRoot, commitSha, documentPath, expectedRepository);
  const status = gitText(repoRoot, ['status', '--porcelain=v1', '--', base.path]);
  if (!status.trim()) return null;
  const absolute = path.resolve(repoRoot, ...base.path.split('/'));
  const relative = path.relative(path.resolve(repoRoot), absolute);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('dirty overlay path escaped repository');
  const deleted = !existsSync(absolute);
  const bytes = deleted ? Buffer.alloc(0) : readFileSync(absolute);
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`${base.path} overlay is not canonical UTF-8 text`);
  return {
    ...base,
    source_kind: 'local_overlay',
    persisted: false,
    base_content_hash: base.content_hash,
    content_hash: sha256(bytes),
    content,
    ...(deleted ? { deleted: true } : {}),
  };
}

/** Overlay dirty Git-owned context at the CLI boundary without issuing a cloud mutation. */
export function overlayDirtyGitContext(repoRoot: string, result: ContextResultDto): ContextResultDto {
  return { ...result, payload: overlayValue(repoRoot, structuredClone(result.payload)) };
}

function overlayValue(repoRoot: string, value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => overlayValue(repoRoot, entry));
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, JsonValue>;
  if (row.source_kind === 'git' && typeof row.repository === 'string' && typeof row.commit_sha === 'string' && typeof row.path === 'string') {
    const overlay = dirtyGitDocumentOverlay(repoRoot, row.commit_sha, row.path, row.repository);
    if (overlay) return overlay as unknown as JsonValue;
  }
  return Object.fromEntries(Object.entries(row).map(([key, child]) => [key, overlayValue(repoRoot, child)]));
}

function normalizeGitPath(value: string): string {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value)) throw new Error('Git document path must be repository-relative');
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('Git document path escaped repository');
  return normalized;
}

function assertInsideRepository(repoRoot: string, absolutePath: string): void {
  const relative = path.relative(path.resolve(repoRoot), absolutePath);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('promotion path escaped repository');
}

function documentKind(documentPath: string): string {
  const basename = path.posix.basename(documentPath, path.posix.extname(documentPath));
  if (documentPath === '.tenbo/overview.md') return 'overview';
  if (documentPath === '.tenbo/principles.md') return 'principles';
  if (basename === 'intent') return 'layer-intent';
  if (basename === 'code-map') return 'code-map';
  return basename || 'documentation';
}

function canonicalRepository(value: string): string {
  return value.trim().replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}

function gitText(repoRoot: string, args: string[]): string {
  return gitBytes(repoRoot, args).toString('utf8');
}

function gitBytes(repoRoot: string, args: string[]): Buffer {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
    throw new Error(`git ${args[0]} failed: ${stderr}`);
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
