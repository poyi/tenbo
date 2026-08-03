import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TenboHttpCredential } from './HttpTenboTransport';
import {
  readCloudProjectPointer,
  type CloudProjectPointer,
} from './cloudProjectPointer';
import { TENBO_CLIENT_VERSION } from '../contracts/tenbo';

export const CLOUD_ENV = Object.freeze({
  apiUrl: 'TENBO_CLOUD_API_URL',
  projectId: 'TENBO_CLOUD_PROJECT_ID',
  apiKey: 'TENBO_CLOUD_ANON_KEY',
  agentToken: 'TENBO_CLOUD_AGENT_TOKEN',
  humanJwt: 'TENBO_CLOUD_HUMAN_JWT',
  credentialsFile: 'TENBO_CLOUD_CREDENTIALS_FILE',
});

export interface CloudRuntimeConfig {
  apiUrl: string;
  projectId: string;
  apiKey?: string;
  credential: TenboHttpCredential;
  backendEpoch?: number;
  clientVersion?: string;
  pointer?: CloudProjectPointer;
}

interface ExternalCloudConfig {
  api_url?: unknown;
  project_id?: unknown;
  anon_key?: unknown;
  agent_token?: unknown;
  human_jwt?: unknown;
}

export interface LoadCloudConfigOptions {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  optional?: boolean;
}

/**
 * Resolve cloud configuration. Explicit process/external-profile credentials
 * take precedence. A canonical private-repository pointer may intentionally
 * carry a project-scoped agent capability as the zero-setup fallback.
 */
export function loadCloudConfig(options: LoadCloudConfigOptions = {}): CloudRuntimeConfig | null {
  const env = options.env ?? process.env;
  const pointer = options.repoRoot ? readCloudProjectPointer(options.repoRoot) : null;
  const explicitFilePath = env[CLOUD_ENV.credentialsFile]?.trim();
  const hasInlineSignal = [CLOUD_ENV.apiUrl, CLOUD_ENV.projectId, CLOUD_ENV.agentToken, CLOUD_ENV.humanJwt]
    .some((name) => Boolean(env[name]?.trim()));
  const pointerIsCanonical = pointer?.mode === 'cloud_canonical';
  if (!explicitFilePath && !hasInlineSignal && !pointerIsCanonical) {
    if (options.optional) return null;
    throw new Error(`Tenbo cloud is not configured; set ${CLOUD_ENV.credentialsFile} or ${CLOUD_ENV.apiUrl}`);
  }

  const discoveredFilePath = explicitFilePath ?? (pointerIsCanonical ? defaultCredentialPath(pointer!, env) : undefined);
  const external = discoveredFilePath && (explicitFilePath || existsSync(path.resolve(discoveredFilePath)))
    ? readExternalConfig(discoveredFilePath, options.repoRoot)
    : {};
  const apiUrl = required(env[CLOUD_ENV.apiUrl] ?? external.api_url ?? pointer?.api_url, CLOUD_ENV.apiUrl);
  const projectId = required(env[CLOUD_ENV.projectId] ?? external.project_id ?? pointer?.project_id, CLOUD_ENV.projectId);
  const apiKey = optionalString(env[CLOUD_ENV.apiKey] ?? external.anon_key);
  const configuredAgentToken = optionalString(env[CLOUD_ENV.agentToken] ?? external.agent_token);
  const humanJwt = optionalString(env[CLOUD_ENV.humanJwt] ?? external.human_jwt);
  const agentToken = configuredAgentToken
    ?? (humanJwt ? undefined : optionalString(pointerIsCanonical ? pointer?.repository_agent_token : undefined));
  if (!agentToken && !humanJwt && pointerIsCanonical) {
    throw new Error(
      `Tenbo cloud credentials are required; add a repository capability, create chmod-600 ${defaultCredentialPath(pointer!, env)}, or set ${CLOUD_ENV.agentToken}`,
    );
  }
  if (Boolean(agentToken) === Boolean(humanJwt)) {
    throw new Error(`configure exactly one of ${CLOUD_ENV.agentToken} or ${CLOUD_ENV.humanJwt}`);
  }
  validateEndpoint(apiUrl);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
    throw new Error(`${CLOUD_ENV.projectId} must be a UUID`);
  }
  if (pointerIsCanonical) {
    if (apiUrl !== pointer!.api_url || projectId !== pointer!.project_id) {
      throw new Error('Tenbo cloud credentials/configuration do not match the canonical project pointer');
    }
  }
  return {
    apiUrl,
    projectId,
    ...(apiKey ? { apiKey } : {}),
    credential: agentToken ? { type: 'agent', token: agentToken } : { type: 'human', jwt: humanJwt! },
    backendEpoch: pointer?.backend_epoch ?? 1,
    clientVersion: TENBO_CLIENT_VERSION,
    ...(pointer ? { pointer } : {}),
  };
}

function readExternalConfig(filePath: string, repoRoot?: string): ExternalCloudConfig {
  const candidate = path.resolve(filePath);
  if (!existsSync(candidate)) throw new Error(`${CLOUD_ENV.credentialsFile} must name a file`);
  const resolved = realpathSync(candidate);
  if (!statSync(resolved).isFile()) throw new Error(`${CLOUD_ENV.credentialsFile} must name a file`);
  if (repoRoot) {
    const root = realpathSync(path.resolve(repoRoot));
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(`${CLOUD_ENV.credentialsFile} must be outside the repository`);
    }
  }
  if (process.platform !== 'win32' && (statSync(resolved).mode & 0o077) !== 0) {
    throw new Error(`${CLOUD_ENV.credentialsFile} must not be accessible by group or other users (chmod 600)`);
  }
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed as ExternalCloudConfig;
  } catch (error) {
    throw new Error(`invalid ${CLOUD_ENV.credentialsFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultCredentialPath(pointer: CloudProjectPointer, env: NodeJS.ProcessEnv): string {
  const configRoot = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'tenbo', `${pointer.credential_profile}.json`);
}

function required(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new Error(`${name} is required`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validateEndpoint(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${CLOUD_ENV.apiUrl} must be an absolute URL`); }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`${CLOUD_ENV.apiUrl} must use HTTPS outside localhost`);
  }
}
