import {
  type CommandEnvelopeDto,
  type QueryEnvelopeDto,
  type TenboCommandResult,
  TenboContractError,
  type TenboGatewayPort,
  type TenboQueryResult,
} from '../contracts/tenbo';
import { defaultFetch } from './defaultFetch';
import { normalizeCloudCommandResult, normalizeCloudQueryResult } from './normalizeCloudResults';

export type TenboHttpCredential =
  | { type: 'agent'; token: string }
  | { type: 'human'; jwt: string };

export interface HttpTenboTransportOptions {
  endpoint: string;
  /** Supabase anon/publishable key. It identifies the Edge project; it is not an authorization credential. */
  apiKey?: string;
  credential: TenboHttpCredential | (() => TenboHttpCredential | Promise<TenboHttpCredential>);
  fetchImpl?: typeof fetch;
}

type GatewayErrorBody = {
  error?: { code?: string; message?: string } | string;
  code?: string;
  message?: string;
};

/**
 * Browser/server-neutral HTTP transport for the Tenbo Edge gateway.
 *
 * Supabase headers and gateway error bodies are normalized here. Domain callers
 * receive only the x-091 DTOs and TenboContractError; no PostgREST/Supabase shape
 * crosses this boundary.
 */
export class HttpTenboTransport implements TenboGatewayPort {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTenboTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async query(request: QueryEnvelopeDto): Promise<TenboQueryResult> {
    return normalizeCloudQueryResult(await this.post(request));
  }

  async command(request: CommandEnvelopeDto): Promise<TenboCommandResult> {
    return normalizeCloudCommandResult(await this.post(request));
  }

  private async post(body: unknown): Promise<unknown> {
    const credential = typeof this.options.credential === 'function'
      ? await this.options.credential()
      : this.options.credential;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.options.apiKey) headers.apikey = this.options.apiKey;
    if (credential.type === 'agent') headers['X-Tenbo-Agent-Token'] = credential.token;
    else headers.Authorization = `Bearer ${credential.jwt}`;

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new TenboContractError('unsupported', `Tenbo cloud is unavailable: ${messageOf(error)}`);
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new TenboContractError('unsupported', `Tenbo cloud returned non-JSON HTTP ${response.status}`);
    }
    if (!response.ok) throw cloudError(response.status, payload);
    return payload;
  }
}

export function cloudError(status: number, payload: unknown): TenboContractError {
  const row = payload && typeof payload === 'object' ? payload as GatewayErrorBody : {};
  const nested = row.error && typeof row.error === 'object' ? row.error : undefined;
  const cloudCode = nested?.code ?? row.code ?? (typeof row.error === 'string' ? row.error : undefined);
  const message = nested?.message ?? row.message ?? `Tenbo cloud request failed with HTTP ${status}`;
  const code = status === 404 ? 'not_found'
    : status === 409 ? 'conflict'
    : status === 401 || status === 403 ? 'permission_denied'
    : status === 400 || status === 422 || status === 426 ? 'invalid_request'
    : 'unsupported';
  return new TenboContractError(code, cloudCode ? `${cloudCode}: ${message}` : message);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
