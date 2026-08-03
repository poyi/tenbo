import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenboBackendPorts } from '../contracts/tenbo';
import { dirtyGitDocumentOverlay, ingestExactCommitGitDocument, overlayDirtyGitContext, readExactCommitGitDocument } from './trustedGitDocuments';

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

  it('derives bytes from git show before sending the admin command', async () => {
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
      project: { exportProject: async () => ({ project: { repository: 'https://example.test/repo.git' } }) },
      gitDocuments: { execute },
    } as unknown as TenboBackendPorts;
    await ingestExactCommitGitDocument(ports, repo, sha, 'guide.md', { id: 'ci', type: 'agent' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ content: 'trusted\n', commit_sha: sha }), { id: 'ci', type: 'agent' });
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
