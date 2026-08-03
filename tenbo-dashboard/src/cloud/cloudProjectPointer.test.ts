import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { setItemStatus } from '../api/lib/roadmapStore';
import { TENBO_CLIENT_VERSION } from '../contracts/tenbo';
import { loadCloudConfig } from './cloudConfig';
import {
  CLOUD_PROJECT_POINTER_PATH,
  parseCloudProjectPointer,
  readCloudProjectPointer,
} from './cloudProjectPointer';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('cloud project pointer', () => {
  it('keeps the advertised gateway client version aligned with the package release', () => {
    const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string };
    expect(packageJson.version).toBe(TENBO_CLIENT_VERSION);
  });

  it('routes a canonical project through its external credential profile without per-shell cloud variables', () => {
    const root = temporary('tenbo-pointer-repo-');
    const configRoot = temporary('tenbo-pointer-config-');
    write(root, CLOUD_PROJECT_POINTER_PATH, JSON.stringify(pointer('cloud_canonical')));
    const credentialFile = path.join(configRoot, 'tenbo', 'fixture.json');
    writeAbsolute(credentialFile, JSON.stringify({ anon_key: 'public-key', agent_token: 'opaque-secret' }));
    chmodSync(credentialFile, 0o600);

    expect(readCloudProjectPointer(root)?.minimum_cli_version).toBe(TENBO_CLIENT_VERSION);
    expect(loadCloudConfig({ repoRoot: root, env: { XDG_CONFIG_HOME: configRoot } })).toMatchObject({
      apiUrl: 'https://project.example.test/functions/v1/tenbo-api',
      projectId: PROJECT_ID,
      apiKey: 'public-key',
      credential: { type: 'agent', token: 'opaque-secret' },
      backendEpoch: 1,
      clientVersion: TENBO_CLIENT_VERSION,
    });
  });

  it('uses a canonical private-repository capability without machine-specific setup', () => {
    const root = temporary('tenbo-pointer-repository-capability-');
    write(root, CLOUD_PROJECT_POINTER_PATH, JSON.stringify({
      ...pointer('cloud_canonical'),
      repository_agent_token: `tenbo_agent_${'r'.repeat(48)}`,
    }));

    expect(loadCloudConfig({ repoRoot: root, env: {} })).toMatchObject({
      apiUrl: 'https://project.example.test/functions/v1/tenbo-api',
      projectId: PROJECT_ID,
      credential: { type: 'agent', token: `tenbo_agent_${'r'.repeat(48)}` },
    });
  });

  it('lets an explicit human profile override the repository capability', () => {
    const root = temporary('tenbo-pointer-human-override-');
    const configRoot = temporary('tenbo-pointer-human-config-');
    write(root, CLOUD_PROJECT_POINTER_PATH, JSON.stringify({
      ...pointer('cloud_canonical'),
      repository_agent_token: `tenbo_agent_${'r'.repeat(48)}`,
    }));
    const credentialFile = path.join(configRoot, 'tenbo', 'fixture.json');
    writeAbsolute(credentialFile, JSON.stringify({ human_jwt: 'human-session' }));
    chmodSync(credentialFile, 0o600);

    expect(loadCloudConfig({ repoRoot: root, env: { XDG_CONFIG_HOME: configRoot } })).toMatchObject({
      credential: { type: 'human', jwt: 'human-session' },
    });
  });

  it('rejects malformed repository capabilities', () => {
    expect(() => parseCloudProjectPointer({
      ...pointer('cloud_canonical'),
      repository_agent_token: 'not-a-tenbo-token',
    })).toThrow(/opaque Tenbo agent token/);
  });

  it('rejects obsolete CLI metadata and freezes every local roadmap write after cutover', () => {
    expect(() => parseCloudProjectPointer({ ...pointer('cloud_canonical'), minimum_cli_version: '99.0.0' }))
      .toThrow(/obsolete/);

    const root = temporary('tenbo-frozen-repo-');
    write(root, CLOUD_PROJECT_POINTER_PATH, JSON.stringify(pointer('cloud_canonical')));
    write(root, '.tenbo/workspace.yaml', 'scopes:\n  - id: editor\n    path: apps/editor\n    description: editor\ncross_cutting: []\n');
    write(root, '.tenbo/scopes/editor/architecture.yaml', 'layers: []\n');
    const roadmap = '.tenbo/scopes/editor/roadmap.yaml';
    write(root, roadmap, 'items:\n  - id: ed-1\n    title: Frozen\n    description: frozen\n    status: later\n');
    const before = readFileSync(path.join(root, roadmap), 'utf8');
    expect(() => setItemStatus(root, 'ed-1', 'now')).toThrow(/writes are frozen/);
    expect(readFileSync(path.join(root, roadmap), 'utf8')).toBe(before);
  });

  it('does not auto-route a pre-cutover pointer without explicit credentials', () => {
    const root = temporary('tenbo-precutover-repo-');
    write(root, CLOUD_PROJECT_POINTER_PATH, JSON.stringify(pointer('pre_cutover')));
    expect(loadCloudConfig({ repoRoot: root, env: {}, optional: true })).toBeNull();
  });
});

function pointer(mode: 'pre_cutover' | 'cloud_canonical') {
  return {
    format: 'tenbo-cloud-project', version: 1, mode,
    api_url: 'https://project.example.test/functions/v1/tenbo-api', project_id: PROJECT_ID,
    credential_profile: 'fixture', backend_epoch: 1, schema_version: 1,
    minimum_cli_version: TENBO_CLIENT_VERSION, dashboard_url: 'https://dashboard.example.test',
    cutover_at: mode === 'cloud_canonical' ? '2026-08-03T12:00:00Z' : null,
    migration_record: { canonical_hash: 'a'.repeat(64) },
    recovery_policy: { owner: 'platform', encrypted: true, signed: true },
  };
}

function temporary(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string): void {
  writeAbsolute(path.join(root, relative), content);
}

function writeAbsolute(absolute: string, content: string): void {
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}
