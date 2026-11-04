import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliTenboClient } from '../clients/CliTenboClient';
import { TENBO_CLIENT_VERSION, TENBO_SCHEMA_VERSION, TenboContractError } from '../contracts/tenbo';
import { HttpTenboTransport } from './HttpTenboTransport';
import { CLOUD_ENV, loadCloudConfig } from './cloudConfig';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('HttpTenboTransport', () => {
  it('uses an opaque agent token and returns only the domain result', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-tenbo-agent-token')).toBe('tenbo_agent_secret');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(new Headers(init?.headers).get('apikey')).toBe('anon');
      return new Response(JSON.stringify({ kind: 'allocation', item_id: 'x-101' }), { status: 200 });
    });
    const transport = new HttpTenboTransport({
      endpoint: 'https://project.supabase.co/functions/v1/tenbo-api',
      apiKey: 'anon',
      credential: { type: 'agent', token: 'tenbo_agent_secret' },
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(transport.command({
      schema_version: TENBO_SCHEMA_VERSION,
      project_id: PROJECT_ID,
      mutation_id: 'mutation-1',
      actor: { id: 'ignored-by-server', type: 'agent' },
      command: { kind: 'allocateItemId', prefix: 'x' },
    })).resolves.toEqual({ kind: 'allocation', item_id: 'x-101' });
  });

  it('refreshes human JWTs and maps cloud errors into transport-neutral errors', async () => {
    let calls = 0;
    const transport = new HttpTenboTransport({
      endpoint: 'https://project.supabase.co/functions/v1/tenbo-api',
      credential: async () => ({ type: 'human', jwt: `jwt-${++calls}` }),
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer jwt-${calls}`);
        return new Response(JSON.stringify({ error: { code: 'wrong_project', message: 'denied' } }), { status: 403 });
      }) as typeof fetch,
    });
    await expect(transport.query({ schema_version: 1, project_id: PROJECT_ID, query: { kind: 'getSessionContext' } }))
      .rejects.toMatchObject({ name: 'TenboContractError', code: 'permission_denied', message: 'wrong_project: denied' });
    expect(calls).toBe(1);
  });

  it('normalizes cloud item notes before they cross the transport boundary', async () => {
    const transport = new HttpTenboTransport({
      endpoint: 'https://project.supabase.co/functions/v1/tenbo-api',
      credential: { type: 'agent', token: 'tenbo_agent_secret' },
      fetchImpl: (async () => new Response(JSON.stringify({
        kind: 'item',
        value: {
          scope_id: 'editor',
          version: '2',
          archived: false,
          item: { id: 'x-096', title: 'Cloud item', status: 'next', description: 'cloud', notes: ['first', '- second'] },
        },
      }), { status: 200 })) as typeof fetch,
    });

    await expect(transport.query({
      schema_version: TENBO_SCHEMA_VERSION,
      project_id: PROJECT_ID,
      query: { kind: 'getItem', item_id: 'x-096' },
    })).resolves.toMatchObject({ kind: 'item', value: { item: { notes: '- first\n- second' } } });
  });
});

describe('external cloud configuration', () => {
  it('loads a chmod-600 file outside the repo and does not expose secrets in errors', () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'tenbo-cloud-config-'));
    roots.push(parent);
    const repo = path.join(parent, 'repo');
    mkdirSync(repo);
    const configFile = path.join(parent, 'credentials.json');
    writeFileSync(configFile, JSON.stringify({
      api_url: 'https://project.supabase.co/functions/v1/tenbo-api',
      project_id: PROJECT_ID,
      anon_key: 'anon',
      agent_token: 'tenbo_agent_secret',
    }));
    chmodSync(configFile, 0o600);
    expect(loadCloudConfig({ env: { [CLOUD_ENV.credentialsFile]: configFile }, repoRoot: repo })).toEqual({
      apiUrl: 'https://project.supabase.co/functions/v1/tenbo-api',
      projectId: PROJECT_ID,
      apiKey: 'anon',
      credential: { type: 'agent', token: 'tenbo_agent_secret' },
      backendEpoch: 1,
      clientVersion: TENBO_CLIENT_VERSION,
    });
  });

  it('rejects repository-owned credential files and ambiguous credentials', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-cloud-repo-'));
    roots.push(repo);
    const configFile = path.join(repo, 'credentials.json');
    writeFileSync(configFile, JSON.stringify({ api_url: 'https://example.test', project_id: PROJECT_ID, agent_token: 'secret' }));
    chmodSync(configFile, 0o600);
    expect(() => loadCloudConfig({ env: { [CLOUD_ENV.credentialsFile]: configFile }, repoRoot: repo })).toThrow(/outside the repository/);
    expect(() => loadCloudConfig({ env: {
      [CLOUD_ENV.apiUrl]: 'https://example.test',
      [CLOUD_ENV.projectId]: PROJECT_ID,
      [CLOUD_ENV.agentToken]: 'agent',
      [CLOUD_ENV.humanJwt]: 'human',
    } })).toThrow(/exactly one/);
  });

  it('prefers an explicit environment token over a repository capability', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'tenbo-cloud-repository-token-'));
    roots.push(repo);
    mkdirSync(path.join(repo, '.tenbo'));
    writeFileSync(path.join(repo, '.tenbo', 'cloud-project.json'), JSON.stringify({
      format: 'tenbo-cloud-project',
      version: 1,
      mode: 'cloud_canonical',
      api_url: 'https://project.supabase.co/functions/v1/tenbo-api',
      project_id: PROJECT_ID,
      credential_profile: 'fixture',
      repository_agent_token: `tenbo_agent_${'r'.repeat(48)}`,
      backend_epoch: 1,
      schema_version: 1,
      minimum_cli_version: TENBO_CLIENT_VERSION,
      dashboard_url: 'https://dashboard.example.test',
      cutover_at: '2026-08-03T12:00:00Z',
      migration_record: {},
      recovery_policy: {},
    }));

    expect(loadCloudConfig({
      repoRoot: repo,
      env: { [CLOUD_ENV.agentToken]: `tenbo_agent_${'e'.repeat(48)}` },
    })).toMatchObject({ credential: { type: 'agent', token: `tenbo_agent_${'e'.repeat(48)}` } });

    const externalRoot = mkdtempSync(path.join(os.tmpdir(), 'tenbo-external-profile-'));
    roots.push(externalRoot);
    const profile = path.join(externalRoot, 'profile.json');
    writeFileSync(profile, JSON.stringify({ agent_token: `tenbo_agent_${'p'.repeat(48)}` }), { mode: 0o600 });
    expect(loadCloudConfig({ repoRoot: repo, env: { [CLOUD_ENV.credentialsFile]: profile } }))
      .toMatchObject({ credential: { type: 'agent', token: `tenbo_agent_${'p'.repeat(48)}` } });
    writeFileSync(profile, JSON.stringify({ human_jwt: 'explicit-human-session' }));
    expect(loadCloudConfig({ repoRoot: repo, env: { [CLOUD_ENV.credentialsFile]: profile } }))
      .toMatchObject({ credential: { type: 'human', jwt: 'explicit-human-session' } });
  });
});

describe('CliTenboClient cloud single-write mode', () => {
  it('sends cloud commands once and never discovers/falls back to a local hub', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'stale' } }), { status: 409 }));
    const client = new CliTenboClient('/definitely/not/a/tenbo/repo', {
      cloudConfig: {
        apiUrl: 'https://example.test/functions/v1/tenbo-api',
        projectId: PROJECT_ID,
        credential: { type: 'agent', token: 'secret' },
      },
      fetchImpl: fetchImpl as typeof fetch,
      mutationId: () => 'fixed-mutation',
    });
    await expect(client.command({ kind: 'setStatus', item_id: 'x-1', status: 'now' }, { id: 'agent', type: 'agent' }))
      .rejects.toBeInstanceOf(TenboContractError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
