import {
  type CommandEnvelopeDto,
  type QueryEnvelopeDto,
  type TenboCommandResult,
  TenboContractError,
  type TenboGatewayPort,
  type TenboQueryResult,
} from '../contracts/tenbo';
import { cloudError, messageOf } from './HttpTenboTransport';
import { defaultFetch } from './defaultFetch';

export interface HumanHttpTenboTransportOptions {
  endpoint: string;
  apiKey?: string;
  credential: { type: 'human'; jwt: string } | (() => { type: 'human'; jwt: string } | Promise<{ type: 'human'; jwt: string }>);
  fetchImpl?: typeof fetch;
}

/** Human-only browser transport. Its compiled graph cannot carry agent credentials. */
export class HumanHttpTenboTransport implements TenboGatewayPort {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HumanHttpTenboTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  query(request: QueryEnvelopeDto): Promise<TenboQueryResult> {
    return this.post<TenboQueryResult>(request);
  }

  command(request: CommandEnvelopeDto): Promise<TenboCommandResult> {
    return this.post<TenboCommandResult>(request);
  }

  private async post<T>(body: unknown): Promise<T> {
    const credential = typeof this.options.credential === 'function' ? await this.options.credential() : this.options.credential;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.jwt}`,
    };
    if (this.options.apiKey) headers.apikey = this.options.apiKey;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (error) {
      throw new TenboContractError('unsupported', `Tenbo cloud is unavailable: ${messageOf(error)}`);
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = text ? JSON.parse(text) : null; }
    catch { throw new TenboContractError('unsupported', `Tenbo cloud returned non-JSON HTTP ${response.status}`); }
    if (!response.ok) throw cloudError(response.status, payload);
    return payload as T;
  }
}
