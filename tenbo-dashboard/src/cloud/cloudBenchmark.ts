import {
  TENBO_BACKEND_EPOCH,
  TENBO_CLIENT_VERSION,
  TENBO_SCHEMA_VERSION,
  type ContextResultDto,
  type TenboGatewayPort,
  type TenboQuery,
  type TenboQueryResult,
} from '../contracts/tenbo';

export const CLOUD_BENCHMARK_FORMAT = 'tenbo-cloud-benchmark-v1' as const;

export interface CloudBenchmarkFixture {
  format: typeof CLOUD_BENCHMARK_FORMAT;
  schema_version: 1;
  project_id: string;
  source: { manifest_hash: string; commit_sha: string; counts: Record<string, number> };
  deployment: { project_ref: string; region: string; api_schema_version: number; backend_epoch: number; minimum_cli_version: string };
  response_caps: { feature: { rows: number; bytes: number; tokens: number; estimator: 'tenbo-token-estimator-v1' }; item_page_rows: number };
  samples: { warmups: 3; warm: 30; cold_processes: 5 };
  gates_ms: { item_brief_warm_p95: number; filtered_items_warm_p95: number; feature_context_warm_p95: number };
  queries: {
    item_id: string;
    item_filters: Record<string, unknown>;
    item_projection: 'summary';
    feature_query: string;
  };
}

export interface BenchmarkDurations {
  item_brief_ms: number;
  filtered_items_ms: number;
  feature_context_ms: number;
}

export interface CloudBenchmarkReport {
  ok: boolean;
  format: typeof CLOUD_BENCHMARK_FORMAT;
  fixture_manifest_hash: string;
  deployment: CloudBenchmarkFixture['deployment'];
  samples: CloudBenchmarkFixture['samples'];
  warm_p95_ms: BenchmarkDurations;
  cold_process: { process_wall_p95_ms: number; samples: Array<BenchmarkDurations & { process_wall_ms: number }> };
  caps: { ok: boolean; observed: ContextResultDto['bounds'] };
  gates: Record<keyof BenchmarkDurations, { limit_ms: number; observed_ms: number; passed: boolean }>;
}

export type ColdProcessProbe = () => Promise<BenchmarkDurations & { process_wall_ms: number }>;

export function parseCloudBenchmarkFixture(value: unknown): CloudBenchmarkFixture {
  const row = object(value, 'benchmark fixture') as unknown as CloudBenchmarkFixture;
  if (row.format !== CLOUD_BENCHMARK_FORMAT || row.schema_version !== 1) throw new Error('unsupported Tenbo cloud benchmark fixture');
  if (!uuid(row.project_id) || !hex(row.source?.manifest_hash, 64) || !hex(row.source?.commit_sha, 40, 64)) {
    throw new Error('benchmark fixture project/source identity is invalid');
  }
  if (row.deployment.api_schema_version !== TENBO_SCHEMA_VERSION || row.deployment.backend_epoch !== TENBO_BACKEND_EPOCH
    || row.deployment.minimum_cli_version !== TENBO_CLIENT_VERSION) {
    throw new Error('benchmark fixture schema/backend/client version does not match this Tenbo CLI');
  }
  if (!row.deployment.region || !row.deployment.project_ref) throw new Error('benchmark fixture must pin deployment region and project ref');
  if (row.samples.warmups !== 3 || row.samples.warm !== 30 || row.samples.cold_processes !== 5) {
    throw new Error('benchmark fixture must pin 3 warmups, 30 warm samples, and 5 cold processes');
  }
  if (row.response_caps.feature.estimator !== 'tenbo-token-estimator-v1'
    || row.response_caps.feature.rows !== 32 || row.response_caps.feature.bytes !== 65_536
    || row.response_caps.feature.tokens !== 4_000 || row.response_caps.item_page_rows < 1) {
    throw new Error('benchmark fixture response caps are incompatible');
  }
  for (const value of Object.values(row.gates_ms)) if (!(value > 0)) throw new Error('benchmark gates must be positive');
  if (!row.queries.item_id || row.queries.item_projection !== 'summary' || !row.queries.feature_query) {
    throw new Error('benchmark fixture queries are incomplete');
  }
  return row;
}

export async function runCloudBenchmark(
  gateway: TenboGatewayPort,
  fixtureValue: unknown,
  coldProbe: ColdProcessProbe,
): Promise<CloudBenchmarkReport> {
  const fixture = parseCloudBenchmarkFixture(fixtureValue);
  for (let index = 0; index < fixture.samples.warmups; index += 1) await runBenchmarkProbe(gateway, fixture);
  const warm: BenchmarkDurations[] = [];
  let observedBounds: ContextResultDto['bounds'] | undefined;
  for (let index = 0; index < fixture.samples.warm; index += 1) {
    const result = await runBenchmarkProbe(gateway, fixture);
    warm.push(result.durations);
    observedBounds = result.feature.bounds;
  }
  if (!observedBounds) throw new Error('benchmark produced no feature-context bounds');
  const cold = [];
  for (let index = 0; index < fixture.samples.cold_processes; index += 1) cold.push(await coldProbe());
  const warmP95 = {
    item_brief_ms: p95(warm.map((sample) => sample.item_brief_ms)),
    filtered_items_ms: p95(warm.map((sample) => sample.filtered_items_ms)),
    feature_context_ms: p95(warm.map((sample) => sample.feature_context_ms)),
  };
  const cap = fixture.response_caps.feature;
  const capsOk = observedBounds.row_count <= cap.rows && observedBounds.byte_count <= cap.bytes
    && observedBounds.token_estimate <= cap.tokens && observedBounds.estimator === cap.estimator;
  const gates = {
    item_brief_ms: gate(warmP95.item_brief_ms, fixture.gates_ms.item_brief_warm_p95),
    filtered_items_ms: gate(warmP95.filtered_items_ms, fixture.gates_ms.filtered_items_warm_p95),
    feature_context_ms: gate(warmP95.feature_context_ms, fixture.gates_ms.feature_context_warm_p95),
  };
  return {
    ok: capsOk && Object.values(gates).every((value) => value.passed),
    format: CLOUD_BENCHMARK_FORMAT,
    fixture_manifest_hash: fixture.source.manifest_hash,
    deployment: fixture.deployment,
    samples: fixture.samples,
    warm_p95_ms: warmP95,
    cold_process: { process_wall_p95_ms: p95(cold.map((sample) => sample.process_wall_ms)), samples: cold },
    caps: { ok: capsOk, observed: observedBounds },
    gates,
  };
}

export async function runBenchmarkProbe(gateway: TenboGatewayPort, fixtureValue: unknown): Promise<{
  durations: BenchmarkDurations;
  feature: ContextResultDto;
}> {
  const fixture = parseCloudBenchmarkFixture(fixtureValue);
  const timed = async (query: TenboQuery) => {
    const start = performance.now();
    const result = await gateway.query({
      schema_version: TENBO_SCHEMA_VERSION, client_version: TENBO_CLIENT_VERSION,
      backend_epoch: TENBO_BACKEND_EPOCH, project_id: fixture.project_id, query,
    });
    return { result, milliseconds: performance.now() - start };
  };
  const brief = await timed({ kind: 'getItem', item_id: fixture.queries.item_id, include_archived: true });
  if (brief.result.kind !== 'item') throw unexpected('item', brief.result);
  const items = await timed({
    kind: 'listItems',
    filters: fixture.queries.item_filters,
    projection: fixture.queries.item_projection,
    page: { limit: fixture.response_caps.item_page_rows },
  });
  if (items.result.kind !== 'itemPage') throw unexpected('itemPage', items.result);
  if (items.result.value.page.row_count > fixture.response_caps.item_page_rows) throw new Error('filtered-item response exceeded fixture row cap');
  const feature = await timed({ kind: 'searchContext', query: fixture.queries.feature_query });
  if (feature.result.kind !== 'context' || feature.result.intent !== 'feature') throw unexpected('feature context', feature.result);
  return {
    durations: {
      item_brief_ms: round(brief.milliseconds), filtered_items_ms: round(items.milliseconds),
      feature_context_ms: round(feature.milliseconds),
    },
    feature: feature.result,
  };
}

function gate(observed_ms: number, limit_ms: number) {
  return { limit_ms, observed_ms, passed: observed_ms <= limit_ms };
}

function p95(values: number[]): number {
  if (values.length === 0) throw new Error('p95 requires samples');
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!);
}

function round(value: number): number { return Math.round(value * 100) / 100; }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function uuid(value: unknown): boolean { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value); }
function hex(value: unknown, min: number, max = min): boolean {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${min},${max}}$`, 'i').test(value);
}
function unexpected(expected: string, result: TenboQueryResult): Error { return new Error(`expected ${expected}, received ${result.kind}`); }
