import { describe, expect, it } from 'vitest';
import type { CommandEnvelopeDto, QueryEnvelopeDto, TenboCommandResult, TenboGatewayPort, TenboQueryResult } from '../contracts/tenbo';
import { parseCloudBenchmarkFixture, runCloudBenchmark } from './cloudBenchmark';

describe('pinned cloud benchmark', () => {
  it('runs exactly 3 warmups, 30 warm samples, and 5 isolated-process probes with cap and p95 gates', async () => {
    const gateway = new FixtureGateway();
    let cold = 0;
    const report = await runCloudBenchmark(gateway, fixture(), async () => {
      cold += 1;
      return { item_brief_ms: 10, filtered_items_ms: 11, feature_context_ms: 12, process_wall_ms: 100 };
    });
    expect(report.ok).toBe(true);
    expect(gateway.queries).toBe((3 + 30) * 3);
    expect(cold).toBe(5);
    expect(report.samples).toEqual({ warmups: 3, warm: 30, cold_processes: 5 });
  });

  it('refuses an incompatible client version instead of silently changing conditions', () => {
    expect(() => parseCloudBenchmarkFixture({ ...fixture(), deployment: { ...fixture().deployment, minimum_cli_version: '0.13.0' } }))
      .toThrow(/does not match/);
  });
});

class FixtureGateway implements TenboGatewayPort {
  queries = 0;
  async query(request: QueryEnvelopeDto): Promise<TenboQueryResult> {
    this.queries += 1;
    if (request.query.kind === 'getItem') return { kind: 'item', value: { scope_id: 'cross-cutting', item: { id: 'x-090', title: 'cloud', status: 'now', description: 'cloud' }, version: '1', archived: false } };
    if (request.query.kind === 'listItems') return { kind: 'itemPage', value: { items: [], page: { row_count: 0, has_more: false } } };
    return { kind: 'context', intent: 'feature', payload: {}, bounds: { row_count: 1, byte_count: 100, token_estimate: 25,
      estimator: 'tenbo-token-estimator-v1', limits: { rows: 32, bytes: 65_536, tokens: 4_000 }, truncated: false } };
  }
  command(_request: CommandEnvelopeDto): Promise<TenboCommandResult> { throw new Error('not used'); }
}

function fixture() {
  return {
    format: 'tenbo-cloud-benchmark-v1', schema_version: 1,
    project_id: '9bb1252c-737c-4188-8772-9bf35ab71124',
    source: { manifest_hash: 'b'.repeat(64), commit_sha: '8'.repeat(40), counts: { items: 1555 } },
    deployment: { project_ref: 'dopxhwhlwlwigobnokvl', region: 'West US (Oregon)', api_schema_version: 1, backend_epoch: 1, minimum_cli_version: '0.14.0' },
    response_caps: { feature: { rows: 32, bytes: 65_536, tokens: 4_000, estimator: 'tenbo-token-estimator-v1' }, item_page_rows: 50 },
    samples: { warmups: 3, warm: 30, cold_processes: 5 },
    gates_ms: { item_brief_warm_p95: 300, filtered_items_warm_p95: 300, feature_context_warm_p95: 2_000 },
    queries: {
      item_id: 'x-090',
      item_filters: { status: ['now', 'next'] },
      item_projection: 'summary',
      feature_query: 'cloud roadmap source of truth',
    },
  } as const;
}
