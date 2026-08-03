import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  TENBO_SCHEMA_VERSION,
} from '../contracts/tenbo';

export const CLOUD_PROJECT_POINTER_PATH = '.tenbo/cloud-project.json';
export const CLOUD_PROJECT_POINTER_FORMAT = 'tenbo-cloud-project' as const;

export interface CloudProjectPointer {
  format: typeof CLOUD_PROJECT_POINTER_FORMAT;
  version: 1;
  mode: 'pre_cutover' | 'cloud_canonical';
  api_url: string;
  project_id: string;
  credential_profile: string;
  repository_agent_token?: string;
  backend_epoch: number;
  schema_version: number;
  minimum_cli_version: string;
  dashboard_url: string;
  cutover_at: string | null;
  migration_record: Record<string, unknown>;
  recovery_policy: Record<string, unknown>;
}

export function readCloudProjectPointer(repoRoot: string): CloudProjectPointer | null {
  const file = path.join(repoRoot, ...CLOUD_PROJECT_POINTER_PATH.split('/'));
  if (!existsSync(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${CLOUD_PROJECT_POINTER_PATH}: ${messageOf(error)}`);
  }
  return parseCloudProjectPointer(value);
}

export function parseCloudProjectPointer(value: unknown): CloudProjectPointer {
  const row = object(value, CLOUD_PROJECT_POINTER_PATH);
  if (row.format !== CLOUD_PROJECT_POINTER_FORMAT || row.version !== 1) {
    throw new Error(`${CLOUD_PROJECT_POINTER_PATH} has an unsupported format or version`);
  }
  if (row.mode !== 'pre_cutover' && row.mode !== 'cloud_canonical') {
    throw new Error(`${CLOUD_PROJECT_POINTER_PATH}.mode must be pre_cutover or cloud_canonical`);
  }
  const pointer: CloudProjectPointer = {
    format: CLOUD_PROJECT_POINTER_FORMAT,
    version: 1,
    mode: row.mode,
    api_url: endpoint(row.api_url, 'api_url'),
    project_id: uuid(row.project_id, 'project_id'),
    credential_profile: profile(row.credential_profile),
    ...(row.repository_agent_token === undefined
      ? {}
      : { repository_agent_token: agentToken(row.repository_agent_token) }),
    backend_epoch: positiveInteger(row.backend_epoch, 'backend_epoch'),
    schema_version: positiveInteger(row.schema_version, 'schema_version'),
    minimum_cli_version: semver(row.minimum_cli_version, 'minimum_cli_version'),
    dashboard_url: endpoint(row.dashboard_url, 'dashboard_url'),
    cutover_at: nullableTimestamp(row.cutover_at),
    migration_record: object(row.migration_record, 'migration_record'),
    recovery_policy: object(row.recovery_policy, 'recovery_policy'),
  };
  if (pointer.mode === 'cloud_canonical' && pointer.cutover_at === null) {
    throw new Error(`${CLOUD_PROJECT_POINTER_PATH}.cutover_at is required in cloud_canonical mode`);
  }
  if (pointer.mode === 'pre_cutover' && pointer.cutover_at !== null) {
    throw new Error(`${CLOUD_PROJECT_POINTER_PATH}.cutover_at must be null before cutover`);
  }
  assertRuntimeCompatible(pointer);
  return pointer;
}

export function assertRuntimeCompatible(pointer: CloudProjectPointer): void {
  if (pointer.schema_version !== TENBO_SCHEMA_VERSION) {
    throw new Error(`Tenbo project schema ${pointer.schema_version} requires a compatible CLI; this CLI supports schema ${TENBO_SCHEMA_VERSION}`);
  }
  if (pointer.backend_epoch !== TENBO_BACKEND_EPOCH) {
    throw new Error(`Tenbo project backend epoch ${pointer.backend_epoch} requires a compatible CLI; this CLI supports epoch ${TENBO_BACKEND_EPOCH}`);
  }
  if (compareSemver(TENBO_CLIENT_VERSION, pointer.minimum_cli_version) < 0) {
    throw new Error(`Tenbo CLI ${TENBO_CLIENT_VERSION} is obsolete for this project; install ${pointer.minimum_cli_version} or newer`);
  }
}

export function assertLegacyRoadmapWritesAllowed(repoRoot: string): void {
  const pointer = readCloudProjectPointer(repoRoot);
  if (pointer?.mode === 'cloud_canonical') {
    throw new Error(
      `Legacy Tenbo roadmap/planning writes are frozen after ${pointer.cutover_at}; use the typed Tenbo CLI with cloud credentials`,
    );
  }
}

export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a.numbers[index]! - b.numbers[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function semverParts(value: string): { numbers: [number, number, number]; prerelease: string } {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ?? '' };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function uuid(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new Error(`${field} must be a UUID`);
  }
  return parsed;
}

function profile(value: unknown): string {
  const parsed = text(value, 'credential_profile');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed)) {
    throw new Error('credential_profile must contain lowercase letters, numbers, and single hyphens');
  }
  return parsed;
}

function agentToken(value: unknown): string {
  const parsed = text(value, 'repository_agent_token');
  if (!/^tenbo_agent_[A-Za-z0-9_-]{32,}$/.test(parsed)) {
    throw new Error('repository_agent_token must be an opaque Tenbo agent token');
  }
  return parsed;
}

function endpoint(value: unknown, field: string): string {
  const parsed = text(value, field);
  let url: URL;
  try { url = new URL(parsed); } catch { throw new Error(`${field} must be an absolute URL`); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`${field} must use HTTPS outside localhost`);
  }
  return parsed.replace(/\/+$/, '');
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function semver(value: unknown, field: string): string {
  const parsed = text(value, field);
  try { semverParts(parsed); } catch { throw new Error(`${field} must be a semantic version`); }
  return parsed;
}

function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  const parsed = text(value, 'cutover_at');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(parsed) || Number.isNaN(Date.parse(parsed))) {
    throw new Error('cutover_at must be null or an RFC3339 UTC timestamp');
  }
  return parsed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
