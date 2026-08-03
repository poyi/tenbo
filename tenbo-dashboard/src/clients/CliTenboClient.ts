import { randomUUID } from 'node:crypto';
import {
  TENBO_SCHEMA_VERSION,
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  type ActorDto,
  type CommandEnvelopeDto,
  type QueryEnvelopeDto,
  type TenboCommand,
  type TenboCommandResult,
  type TenboGatewayPort,
  type TenboQuery,
  type TenboQueryResult,
} from '../contracts/tenbo';
import { LocalTenboBackend } from '../api/backends/LocalTenboBackend';
import { discoverHub } from '../api/lib/hub/discover';
import { maybeAutostartHub } from '../api/lib/hub/autostart';
import { createCloudBackend } from '../cloud/createCloudBackend';
import { defaultFetch } from '../cloud/defaultFetch';
import { loadCloudConfig, type CloudRuntimeConfig } from '../cloud/cloudConfig';

export interface CliTenboClientOptions {
  gateway?: TenboGatewayPort;
  fetchImpl?: typeof fetch;
  mutationId?: () => string;
  cloudConfig?: CloudRuntimeConfig | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * CLI transport client. Local mode routes writes through the discovered hub;
 * callers may inject the x-093 cloud gateway without changing command code.
 */
export class CliTenboClient {
  private readonly gateway: TenboGatewayPort;
  private readonly fetchImpl: typeof fetch;
  private readonly mutationId: () => string;
  private readonly cloudProjectId?: string;
  private readonly backendEpoch: number;
  private readonly clientVersion: string;

  get isCloud(): boolean { return Boolean(this.cloudProjectId); }
  get projectId(): string | undefined { return this.cloudProjectId; }

  constructor(private readonly repoRoot: string, options: CliTenboClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.mutationId = options.mutationId ?? randomUUID;
    const cloud = options.gateway ? null : options.cloudConfig === undefined
      ? loadCloudConfig({ env: options.env, repoRoot, optional: true })
      : options.cloudConfig;
    this.gateway = options.gateway ?? (cloud ? createCloudBackend(cloud, this.fetchImpl) : new LocalTenboBackend(repoRoot));
    this.cloudProjectId = cloud?.projectId;
    this.backendEpoch = cloud?.backendEpoch ?? TENBO_BACKEND_EPOCH;
    this.clientVersion = cloud?.clientVersion ?? TENBO_CLIENT_VERSION;
  }

  query(query: TenboQuery, projectId?: string): Promise<TenboQueryResult> {
    const resolvedProjectId = this.cloudProjectId ?? projectId;
    const request: QueryEnvelopeDto = { schema_version: TENBO_SCHEMA_VERSION, client_version: this.clientVersion,
      backend_epoch: this.backendEpoch, ...(resolvedProjectId ? { project_id: resolvedProjectId } : {}), query };
    return this.gateway.query(request);
  }

  async command(command: TenboCommand, actor: ActorDto, projectId?: string): Promise<TenboCommandResult> {
    const resolvedProjectId = this.cloudProjectId ?? projectId;
    const request: CommandEnvelopeDto = {
      schema_version: TENBO_SCHEMA_VERSION,
      client_version: this.clientVersion,
      backend_epoch: this.backendEpoch,
      mutation_id: this.mutationId(),
      ...(resolvedProjectId ? { project_id: resolvedProjectId } : {}),
      actor,
      command,
    };

    // Cloud is a single-write backend: a failed request is surfaced and must
    // never fall back to the local hub/YAML store.
    if (this.cloudProjectId) return this.gateway.command(request);

    let hub = null;
    try { hub = await discoverHub(this.repoRoot); } catch { hub = null; }
    if (hub) {
      try {
        const response = await this.fetchImpl(`http://127.0.0.1:${hub.port}/api/hub/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(3_000),
        });
        const body = await response.json() as TenboCommandResult | { ok: false; message: string };
        if (!response.ok || ('ok' in body && body.ok === false)) throw new Error('message' in body ? body.message : 'hub command failed');
        return body as TenboCommandResult;
      } catch {
        // Reuse the same mutation id for the direct fallback. The local
        // backend returns the stored result if the hub committed first.
      }
    } else {
      try { maybeAutostartHub(this.repoRoot); } catch { /* advisory only */ }
    }
    return this.gateway.command(request);
  }
}
