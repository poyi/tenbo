import { CloudTenboBackend } from '../api/backends/CloudTenboBackend';
import { HttpTenboTransport } from './HttpTenboTransport';
import type { CloudRuntimeConfig } from './cloudConfig';
import { defaultFetch } from './defaultFetch';
import { TENBO_BACKEND_EPOCH, TENBO_CLIENT_VERSION } from '../contracts/tenbo';

export function createCloudBackend(config: CloudRuntimeConfig, fetchImpl: typeof fetch = defaultFetch): CloudTenboBackend {
  return new CloudTenboBackend(config.projectId, new HttpTenboTransport({
    endpoint: config.apiUrl,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    credential: config.credential,
    fetchImpl,
  }), undefined, {
    backendEpoch: config.backendEpoch ?? TENBO_BACKEND_EPOCH,
    clientVersion: config.clientVersion ?? TENBO_CLIENT_VERSION,
  });
}
