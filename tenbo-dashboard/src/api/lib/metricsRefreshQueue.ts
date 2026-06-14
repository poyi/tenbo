import type { MetricsRefreshStatus, Scope, ScopeMetrics } from '../../types.js';
import { ensureFresh } from './metricsRefresh.js';

const DEFAULT_METRICS_TTL_MS = readDurationEnv('TENBO_METRICS_TTL_MS', 5 * 60 * 1000);
const SLOW_REFRESH_WARNING_MS = readDurationEnv('TENBO_METRICS_REFRESH_WARNING_MS', 5 * 1000);
const FAILED_REFRESH_RETRY_MS = readDurationEnv('TENBO_METRICS_FAILED_RETRY_MS', 30 * 1000);

interface RefreshEntry {
  promise: Promise<ScopeMetrics | undefined> | null;
  startedAtMs: number | null;
  startedAt: string | null;
  lastStatus: MetricsRefreshStatus | null;
}

const refreshes = new Map<string, RefreshEntry>();

function readDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function key(repoRoot: string, scopeId: string): string {
  return `${repoRoot}\0${scopeId}`;
}

function generatedAtMs(metrics: ScopeMetrics | undefined): number | null {
  if (!metrics?.generated_at) return null;
  const parsed = Date.parse(metrics.generated_at);
  return Number.isFinite(parsed) ? parsed : null;
}

function getOrCreateEntry(repoRoot: string, scopeId: string): RefreshEntry {
  const k = key(repoRoot, scopeId);
  let entry = refreshes.get(k);
  if (!entry) {
    entry = { promise: null, startedAtMs: null, startedAt: null, lastStatus: null };
    refreshes.set(k, entry);
  }
  return entry;
}

export function shouldRefreshMetrics(metrics: ScopeMetrics | undefined, now = Date.now(), ttlMs = DEFAULT_METRICS_TTL_MS): boolean {
  const generated = generatedAtMs(metrics);
  if (generated == null) return true;
  return now - generated > ttlMs;
}

function failedRecently(entry: RefreshEntry | undefined, now: number): boolean {
  if (entry?.lastStatus?.status !== 'failed' || !entry.lastStatus.finishedAt) return false;
  const finishedAt = Date.parse(entry.lastStatus.finishedAt);
  return Number.isFinite(finishedAt) && now - finishedAt < FAILED_REFRESH_RETRY_MS;
}

export function requestMetricsRefresh(repoRoot: string, scopeId: string, opts: { force?: boolean; reason?: string } = {}): Promise<ScopeMetrics | undefined> {
  const entry = getOrCreateEntry(repoRoot, scopeId);
  if (entry.promise) return entry.promise;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  entry.startedAtMs = startedAtMs;
  entry.startedAt = startedAt;
  entry.lastStatus = {
    status: 'refreshing',
    startedAt,
    message: opts.reason ?? 'Refreshing health metrics in the background.',
  };

  entry.promise = new Promise<ScopeMetrics | undefined>((resolve) => {
    setTimeout(() => {
      void ensureFresh(repoRoot, scopeId, { force: opts.force }).then(
        (metrics) => {
          entry.promise = null;
          entry.startedAtMs = null;
          entry.startedAt = null;
          entry.lastStatus = {
            status: 'fresh',
            generatedAt: metrics.generated_at,
            finishedAt: new Date().toISOString(),
          };
          resolve(metrics);
        },
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          entry.promise = null;
          entry.startedAtMs = null;
          entry.startedAt = null;
          entry.lastStatus = {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: message,
          };
          console.warn(`tenbo: metric refresh failed for scope ${scopeId}:`, err);
          resolve(undefined);
        },
      );
    }, 0);
  });

  return entry.promise;
}

export function metricsStatusForScope(
  repoRoot: string,
  scopeId: string,
  metrics: ScopeMetrics | undefined,
  opts: { now?: number; ttlMs?: number; slowWarningMs?: number } = {},
): MetricsRefreshStatus {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? DEFAULT_METRICS_TTL_MS;
  const slowWarningMs = opts.slowWarningMs ?? SLOW_REFRESH_WARNING_MS;
  const entry = refreshes.get(key(repoRoot, scopeId));
  const generatedAt = metrics?.generated_at;

  if (entry?.promise) {
    const elapsed = entry.startedAtMs == null ? 0 : now - entry.startedAtMs;
    return {
      status: 'refreshing',
      generatedAt,
      startedAt: entry.startedAt ?? undefined,
      message: 'Refreshing health metrics in the background; cached metrics are still being served.',
      warning: elapsed >= slowWarningMs
        ? `Metrics refresh has been running for ${Math.round(elapsed / 1000)}s; keeping cached metrics visible.`
        : undefined,
    };
  }

  if (entry?.lastStatus?.status === 'failed') {
    return {
      ...entry.lastStatus,
      generatedAt,
      message: 'The last health metrics refresh failed; cached metrics are still being served.',
    };
  }

  const generated = generatedAtMs(metrics);
  if (generated == null) {
    return {
      status: 'stale',
      message: 'No health metrics cache is available yet.',
    };
  }

  if (now - generated > ttlMs) {
    return {
      status: 'stale',
      generatedAt,
      message: 'Health metrics are older than the refresh interval; cached metrics are still being served.',
    };
  }

  return {
    status: 'fresh',
    generatedAt,
  };
}

export function metricsStatusForScopes(
  repoRoot: string,
  scopes: Scope[],
  metricsByScope: Record<string, ScopeMetrics> | undefined,
): Record<string, MetricsRefreshStatus> {
  const statuses: Record<string, MetricsRefreshStatus> = {};
  const now = Date.now();
  for (const scope of scopes) {
    const metrics = metricsByScope?.[scope.id];
    const entry = refreshes.get(key(repoRoot, scope.id));
    if (shouldRefreshMetrics(metrics, now) && !failedRecently(entry, now)) {
      void requestMetricsRefresh(repoRoot, scope.id, {
        reason: metrics
          ? 'Health metrics are stale; refreshing in the background.'
          : 'Health metrics are missing; refreshing in the background.',
      });
    }
    statuses[scope.id] = metricsStatusForScope(repoRoot, scope.id, metrics, { now });
  }
  return statuses;
}

export function resetMetricsRefreshQueueForTests(): void {
  refreshes.clear();
}
