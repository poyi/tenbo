import {
  type CommandEnvelopeDto,
  type QueryEnvelopeDto,
  type TenboCommandResult,
  type TenboGatewayPort,
  type TenboQueryResult,
} from '../contracts/tenbo';
import { HumanHttpTenboTransport, type HumanHttpTenboTransportOptions } from '../cloud/HumanHttpTenboTransport';
import { defaultFetch } from '../cloud/defaultFetch';

export type BrowserTenboClientOptions =
  | { mode?: 'local'; baseUrl?: string; fetchImpl?: typeof fetch }
  | ({ mode: 'cloud' } & HumanHttpTenboTransportOptions);

/** Browser-only HTTP transport. This module deliberately has no server/storage imports. */
export class BrowserTenboClient implements TenboGatewayPort {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cloud?: HumanHttpTenboTransport;

  constructor(options: BrowserTenboClientOptions | string = {}, legacyFetchImpl: typeof fetch = defaultFetch) {
    if (typeof options === 'string') {
      this.baseUrl = options;
      this.fetchImpl = legacyFetchImpl;
      return;
    }
    this.baseUrl = options.mode === 'cloud' ? '' : (options.baseUrl ?? '/api/tenbo');
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    if (options.mode === 'cloud') this.cloud = new HumanHttpTenboTransport(options);
  }

  query(request: QueryEnvelopeDto): Promise<TenboQueryResult> {
    if (this.cloud) return this.cloud.query(request);
    return this.post<TenboQueryResult>('query', request);
  }

  command(request: CommandEnvelopeDto): Promise<TenboCommandResult> {
    if (this.cloud) return this.cloud.command(request);
    return this.post<TenboCommandResult>('command', request);
  }

  private async post<T>(operation: 'query' | 'command', body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${operation}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { ok?: false; message?: string } | T;
    if (!response.ok || (typeof payload === 'object' && payload !== null && 'ok' in payload && payload.ok === false)) {
      const error = payload as { message?: string };
      throw new Error(error.message ?? `Tenbo ${operation} failed with HTTP ${response.status}`);
    }
    return payload as T;
  }
}
