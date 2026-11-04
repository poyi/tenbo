import { describe, expect, it, vi } from 'vitest';
import { CloudDashboardClient, DASHBOARD_AUX_PAGE_SIZE, DASHBOARD_ITEM_PAGE_SIZE, ProjectResponseGuard } from './client';

const PROJECT_A = '00000000-0000-4000-8000-000000000001';
const PROJECT_B = '00000000-0000-4000-8000-000000000002';

describe('CloudDashboardClient bounded human boundary', () => {
  it('keeps the browser receiver when using the default fetch implementation', async () => {
    const originalFetch = globalThis.fetch;
    let receiver: unknown;
    globalThis.fetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(new Response(JSON.stringify({
        kind: 'projectPage',
        value: { projects: [], page: { row_count: 0, has_more: false } },
      }), { status: 200 }));
    } as typeof fetch;
    try {
      const client = new CloudDashboardClient(
        'https://api.test',
        'public-key',
        () => ({ userId: 'user-1', accessToken: 'human-jwt' }),
      );
      await client.listProjects();
      expect(receiver).toBe(globalThis);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses permitted-project discovery without a project and isolates every project read', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      const kind = (body.query as { kind: string }).kind;
      const payload = kind === 'listProjects'
        ? { kind: 'projectPage', value: { projects: [], page: { row_count: 0, has_more: false } } }
        : { kind: 'itemPage', value: { items: [], page: { row_count: 0, has_more: false } } };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const client = new CloudDashboardClient('https://api.test', 'public-key', () => ({ userId: 'user-1', accessToken: 'human-jwt' }), fetchImpl as typeof fetch);
    await client.listProjects({ limit: 999 });
    await client.listItems(PROJECT_A, { status: ['now', 'next', 'later'] }, { limit: 999 });
    await client.listItems(PROJECT_B, { search: 'cloud' }, { limit: 999 });

    expect(requests[0]).not.toHaveProperty('project_id');
    expect((requests[0].query as { page: { limit: number } }).page.limit).toBe(DASHBOARD_AUX_PAGE_SIZE);
    expect(requests[1].project_id).toBe(PROJECT_A);
    expect(requests[2].project_id).toBe(PROJECT_B);
    expect((requests[1].query as { page: { limit: number } }).page.limit).toBe(DASHBOARD_ITEM_PAGE_SIZE);
    expect((requests[1].query as { projection: string }).projection).toBe('summary');
    expect((requests[1].query as { filters: { status: string[] } }).filters.status).toEqual(['now', 'next', 'later']);
    expect(requests.map((request) => (request.query as { kind: string }).kind)).not.toContain('exportProject');
    for (const call of fetchImpl.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer human-jwt');
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('x-tenbo-agent-token');
    }
  });

  it('sends edits only as typed commands attributed to the restored human', async () => {
    let request: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ kind: 'claimReleased', item_id: 'x-1', fencing_token: 7 }), { status: 200 });
    });
    const client = new CloudDashboardClient('https://api.test', 'public-key', () => ({ userId: 'user-1', accessToken: 'human-jwt' }), fetchImpl as typeof fetch);
    await client.command(PROJECT_A, { kind: 'releaseClaim', item_id: 'x-1', owner: 'user-1', fencing_token: 7 });
    expect(request).toMatchObject({
      schema_version: 1, project_id: PROJECT_A,
      actor: { id: 'user-1', type: 'user' },
      command: { kind: 'releaseClaim', item_id: 'x-1', fencing_token: 7 },
    });
    expect(request).not.toHaveProperty('query');
  });

  it('receives the same normalized notes shape as the agent transport', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      kind: 'itemPage',
      value: {
        items: [{
          scope_id: 'editor', version: '3', archived: false,
          item: { id: 'ed-1', title: 'Cloud item', status: 'next', description: 'cloud', notes: ['first', 'second'] },
        }],
        page: { row_count: 1, has_more: false },
      },
    }), { status: 200 }));
    const client = new CloudDashboardClient(
      'https://api.test',
      'public-key',
      () => ({ userId: 'user-1', accessToken: 'human-jwt' }),
      fetchImpl as typeof fetch,
    );

    const page = await client.listItems(PROJECT_A, {});

    expect(page.items[0].item.notes).toBe('- first\n- second');
  });
});

describe('ProjectResponseGuard', () => {
  it('rejects late responses after project switching', () => {
    const guard = new ProjectResponseGuard();
    const a = guard.select(PROJECT_A);
    expect(guard.isCurrent(PROJECT_A, a)).toBe(true);
    const b = guard.select(PROJECT_B);
    expect(guard.isCurrent(PROJECT_A, a)).toBe(false);
    expect(guard.isCurrent(PROJECT_B, b)).toBe(true);
  });
});
