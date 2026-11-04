import { createHash } from 'node:crypto';
import { CloudTenboBackend } from '../api/backends/CloudTenboBackend';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenboBackendPorts } from '../contracts/tenbo';
import {
  dirtyGitDocumentOverlay,
  ingestExactCommitGitDocument,
  overlayDirtyGitContext,
  readExactCommitGitDocument,
  rollbackDocumentPromotionPatch,
  writeDocumentPromotionPatch,
} from './trustedGitDocuments';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('trusted exact-commit Git ingestion', () => {
  it('proves divergent branches by exact SHA and never substitutes worktree bytes', () => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, 'guide.md'), 'main bytes\n');
    git(repo, ['add', 'guide.md']); git(repo, ['commit', '-m', 'main']);
    const mainSha = git(repo, ['rev-parse', 'HEAD']).trim();
    git(repo, ['checkout', '-b', 'divergent']);
    writeFileSync(path.join(repo, 'guide.md'), 'branch bytes\n');
    git(repo, ['commit', '-am', 'branch']);
    const branchSha = git(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repo, 'guide.md'), 'dirty bytes\n');

    const main = readExactCommitGitDocument(repo, mainSha, 'guide.md');
    const branch = readExactCommitGitDocument(repo, branchSha, 'guide.md');
    expect(main.content).toBe('main bytes\n');
    expect(branch.content).toBe('branch bytes\n');
    expect(main.content_hash).not.toBe(branch.content_hash);
    expect(dirtyGitDocumentOverlay(repo, branchSha, 'guide.md')).toMatchObject({
      source_kind: 'local_overlay', persisted: false, content: 'dirty bytes\n', base_content_hash: branch.content_hash,
    });
    const context = overlayDirtyGitContext(repo, {
      kind: 'context', intent: 'feature', payload: { documents: [{ id: 'doc', source_kind: 'git', repository: branch.repository,
        commit_sha: branchSha, path: 'guide.md', content_hash: branch.content_hash, content: branch.content }] },
      bounds: { row_count: 1, byte_count: 100, token_estimate: 25, estimator: 'tenbo-token-estimator-v1',
        limits: { rows: 32, bytes: 65_536, tokens: 4_000 }, truncated: false },
    });
    expect(context.payload).toMatchObject({ documents: [{ source_kind: 'local_overlay', persisted: false, content: 'dirty bytes\n' }] });
  });

  it('rejects a ref label, wrong repository, traversal, and missing committed path', () => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, 'guide.md'), 'bytes\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'one']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    expect(() => readExactCommitGitDocument(repo, 'HEAD', 'guide.md')).toThrow(/full hexadecimal/);
    expect(() => readExactCommitGitDocument(repo, sha, 'guide.md', 'https://example.test/other.git')).toThrow(/does not match/);
    expect(() => readExactCommitGitDocument(repo, sha, '../guide.md')).toThrow(/escaped/);
    expect(() => readExactCommitGitDocument(repo, sha, 'missing.md')).toThrow(/git show failed/);
  });

  it('derives bytes from git show without exporting the project', async () => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, 'guide.md'), 'trusted\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'one']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();
    const execute = vi.fn(async (command: any) => ({
      kind: 'gitDocument' as const,
      value: { id: 'doc', source_kind: 'git' as const, kind: command.document_kind, path: command.path,
        repository: command.repository, commit_sha: command.commit_sha, content_hash: command.content_hash,
        content: command.content, version: '1', archived: false as const },
    }));
    const ports = {
      project: { getIdentity: async () => ({ id: 'project', repository: 'https://example.test/repo.git' }), exportProject: vi.fn(() => { throw new Error('editor cannot execute exportProject'); }) },
      gitDocuments: { execute },
    } as unknown as TenboBackendPorts;
    const result = await ingestExactCommitGitDocument(ports, repo, sha, 'guide.md', { id: 'ci', type: 'agent' });
    expect(result.content_hash).toBe(createHash('sha256').update(execFileSync('git', ['show', `${sha}:guide.md`], { cwd: repo })).digest('hex'));
    expect(ports.project.exportProject).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ content: 'trusted\n', commit_sha: sha }), { id: 'ci', type: 'agent' });
  });

  it.each([
    ['wrong repository', { id: 'project', repository: 'https://example.test/other.git' }, 'guide.md', /does not match/],
    ['empty repository', { id: 'project', repository: '' }, 'guide.md', /repository/],
    ['wrong project', { id: 'other', repository: 'https://example.test/repo.git' }, 'guide.md', /destination project/],
    ['invalid path', { id: 'project', repository: 'https://example.test/repo.git' }, '../guide.md', /escaped/],
  ] as const)('fails closed for %s before ingestion', async (_label, identity, documentPath, expected) => {
    const repo = fixtureRepo();
    writeFileSync(path.join(repo, 'guide.md'), 'trusted\n');
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'one']);
    const command = vi.fn();
    const query = vi.fn(async () => ({ kind: 'projectIdentity' as const, value: identity }));
    const backend = new CloudTenboBackend('project', { query, command });
    await expect(ingestExactCommitGitDocument(backend.ports, repo, git(repo, ['rev-parse', 'HEAD']).trim(), documentPath, { id: 'ci', type: 'agent' })).rejects.toThrow(expected);
    expect(command).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project', query: { kind: 'getProjectIdentity' } }));
  });

  it('propagates identity authorization/unsupported errors without export or local fallback', async () => {
    for (const message of ['permission_denied: unauthorized project', 'unsupported query: getProjectIdentity']) {
      const query = vi.fn(async () => { throw new Error(message); });
      const command = vi.fn();
      const backend = new CloudTenboBackend('project', { query, command });
      await expect(ingestExactCommitGitDocument(backend.ports, '/nonexistent', 'a'.repeat(40), 'AGENTS.md', { id: 'ci', type: 'agent' })).rejects.toThrow(message);
      expect(query).toHaveBeenCalledTimes(1);
      expect(command).not.toHaveBeenCalled();
    }
  });

  it('rejects a returned hash mismatch after reading exact UTF-8/CRLF git bytes', async () => {
    const repo = fixtureRepo();
    git(repo, ['config', 'core.autocrlf', 'false']);
    const bytes = Buffer.from('Documentation café\r\nno trailing newline');
    writeFileSync(path.join(repo, 'guide.md'), bytes);
    git(repo, ['add', '.']); git(repo, ['commit', '-m', 'one']);
    writeFileSync(path.join(repo, 'guide.md'), 'dirty content');
    const command = vi.fn(async (envelope: any) => {
      expect(envelope.command.content_hash).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(Buffer.from(envelope.command.content)).toEqual(bytes);
      return { kind: 'gitDocument', value: { content_hash: '0'.repeat(64) } };
    });
    const backend = new CloudTenboBackend('project', {
      query: async () => ({ kind: 'projectIdentity', value: { id: 'project', repository: 'https://example.test/repo.git' } }), command,
    } as any);
    await expect(ingestExactCommitGitDocument(backend.ports, repo, git(repo, ['rev-parse', 'HEAD']).trim(), 'guide.md', { id: 'ci', type: 'agent' })).rejects.toThrow(/different Git document hash/);
  });

  it('creates a reviewable new file without overwriting repository content', async () => {
    const repo = fixtureRepo();
    const ports = {
      documents: { get: async () => ({
        id: '00000000-0000-4000-8000-000000000010', item_id: 'x-105',
        source_kind: 'planning' as const, kind: 'spec' as const,
        path: '.tenbo/specs/x-105.md', content: '# Canonical spec\n',
        version: '4', archived: false,
      }) },
    } as unknown as TenboBackendPorts;
    const patch = await writeDocumentPromotionPatch(ports, repo, '00000000-0000-4000-8000-000000000010', 'docs/cloud-tenbo.md');
    expect(readFileSync(path.join(repo, 'docs/cloud-tenbo.md'), 'utf8')).toBe('# Canonical spec\n');
    expect(patch).toMatchObject({ source_version: '4', item_id: 'x-105', target_path: 'docs/cloud-tenbo.md' });
    await expect(writeDocumentPromotionPatch(ports, repo, patch.document_id, patch.target_path)).rejects.toThrow(/never overwrites/);
    rollbackDocumentPromotionPatch(repo, patch);
    expect(existsSync(path.join(repo, patch.target_path))).toBe(false);
  });
});

function fixtureRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-git-ingest-'));
  roots.push(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.test']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['remote', 'add', 'origin', 'https://example.test/repo.git']);
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
