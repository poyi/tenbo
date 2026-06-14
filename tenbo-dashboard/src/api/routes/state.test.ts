import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Connect } from 'vite';

const refreshMock = vi.hoisted(() => ({
  deferred: null as null | { promise: Promise<unknown>; resolve: (value?: unknown) => void },
}));

vi.mock('../lib/metricsRefresh.js', () => ({
  ensureFresh: vi.fn(() => refreshMock.deferred?.promise ?? Promise.resolve(undefined)),
}));

function makeTenboRoot(metricsGeneratedAt = '2026-01-01T00:00:00.000Z'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tenbo-state-route-'));
  const scopeDir = path.join(root, '.tenbo', 'scopes', 'editor');
  mkdirSync(path.join(scopeDir, 'layers', 'app'), { recursive: true });
  mkdirSync(path.join(root, 'apps', 'editor', 'src'), { recursive: true });
  writeFileSync(path.join(root, '.tenbo', 'workspace.yaml'), [
    'scopes:',
    '  - id: editor',
    '    path: apps/editor',
    '    description: Editor',
    'cross_cutting: []',
    '',
  ].join('\n'));
  writeFileSync(path.join(scopeDir, 'architecture.yaml'), [
    'layers:',
    '  - id: app',
    '    name: App',
    '    description: App layer',
    '    files: ["src/**"]',
    '',
  ].join('\n'));
  writeFileSync(path.join(scopeDir, 'roadmap.yaml'), [
    'items:',
    '  - id: ed-001',
    '    title: Keep state loading',
    '    status: now',
    '    layer: app',
    '    description: The roadmap should render before metrics refresh finishes.',
    '',
  ].join('\n'));
  writeFileSync(path.join(scopeDir, 'layers', 'app', 'README.md'), '# App\n');
  writeFileSync(path.join(scopeDir, 'metrics.json'), JSON.stringify({
    generated_at: metricsGeneratedAt,
    layers: {
      app: {
        file_count: 1,
        total_lines: 10,
        outbound_deps: 0,
        deep_dive_count: 0,
        intent_age_days: null,
        pct_roadmap_in_now: 100,
      },
    },
    findings: [],
  }));
  writeFileSync(path.join(root, 'apps', 'editor', 'src', 'index.ts'), 'export {};\n');
  return root;
}

async function callStateRoute(handler: Connect.NextHandleFunction): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter() as IncomingMessage;
    req.method = 'GET';
    req.url = '/api/state';

    let body = '';
    const res = new EventEmitter() as ServerResponse;
    res.statusCode = 200;
    res.setHeader = (name, value) => {
      void name;
      void value;
      return res;
    };
    res.end = ((chunk?: any) => {
      if (chunk) body += String(chunk);
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
      return res;
    }) as ServerResponse['end'];

    const timeout = setTimeout(() => reject(new Error('state request timed out')), 250);
    void handler(req, res, () => reject(new Error('route unexpectedly called next()')));
  });
}

describe('stateRoute', () => {
  let root: string;
  let handler: Connect.NextHandleFunction;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    let resolveDeferred!: (value?: unknown) => void;
    const promise = new Promise((resolve) => {
      resolveDeferred = resolve;
    });
    refreshMock.deferred = { promise, resolve: resolveDeferred };
    root = makeTenboRoot();
    const { stateRoute } = await import('./state.js');
    handler = stateRoute(root);
  });

  afterEach(async () => {
    refreshMock.deferred?.resolve({ generated_at: new Date().toISOString(), layers: {}, findings: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { resetMetricsRefreshQueueForTests } = await import('../lib/metricsRefreshQueue.js');
    resetMetricsRefreshQueueForTests();
    rmSync(root, { recursive: true, force: true });
  });

  it('returns cached state promptly when metrics refresh does not finish', async () => {
    const body = await callStateRoute(handler);

    expect(body.scopes[0].items[0].id).toBe('ed-001');
    expect(body.metrics.editor.layers.app.file_count).toBe(1);
    expect(body.metricsStatus.editor.status).toBe('refreshing');
  });

  it('shares one in-flight metrics refresh across concurrent state requests', async () => {
    const [{ ensureFresh }, first, second] = await Promise.all([
      import('../lib/metricsRefresh.js'),
      callStateRoute(handler),
      callStateRoute(handler),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.metricsStatus.editor.status).toBe('refreshing');
    expect(second.metricsStatus.editor.status).toBe('refreshing');
    expect(ensureFresh).toHaveBeenCalledTimes(1);
  });

  it('serves stale cached metrics instead of blocking the state response', async () => {
    const body = await callStateRoute(handler);

    expect(body.metrics.editor.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(['stale', 'refreshing']).toContain(body.metricsStatus.editor.status);
  });
});
