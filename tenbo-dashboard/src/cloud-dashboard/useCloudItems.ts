import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ItemFiltersDto, ItemRecordDto, PageMetaDto } from '../contracts/tenbo';
import { CloudDashboardClient, ProjectResponseGuard } from './client';

// Realtime project-version updates are the normal convergence path. This
// bounded fallback covers a disconnected or blocked websocket without turning
// every dashboard session into a high-frequency poller.
const LIVE_REFRESH_FALLBACK_MS = 30_000;

export function useCloudItems(
  client: CloudDashboardClient,
  projectId: string,
  filters: ItemFiltersDto,
  supabase?: SupabaseClient,
) {
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);
  const guard = useRef(new ProjectResponseGuard());
  const requestRevision = useRef(0);
  const hasItems = useRef(false);
  const [items, setItems] = useState<ItemRecordDto[]>([]);
  const [page, setPage] = useState<PageMetaDto>({ row_count: 0, has_more: false });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partialLiveError, setPartialLiveError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const load = useCallback(async (quiet = false) => {
    const projectRevision = guard.current.select(projectId);
    const revision = ++requestRevision.current;
    if (!quiet) setLoading(true);
    try {
      const result = await client.listItems(projectId, filters);
      if (!guard.current.isCurrent(projectId, projectRevision) || revision !== requestRevision.current) return;
      setItems(result.items);
      hasItems.current = result.items.length > 0;
      setPage(result.page);
      setError(null);
      setPartialLiveError(null);
      setRefreshedAt(new Date());
    } catch (cause) {
      if (!guard.current.isCurrent(projectId, projectRevision) || revision !== requestRevision.current) return;
      const message = errorMessage(cause);
      if (quiet && hasItems.current) setPartialLiveError(message);
      else setError(message);
    } finally {
      if (guard.current.isCurrent(projectId, projectRevision) && revision === requestRevision.current) setLoading(false);
    }
  }, [client, projectId, filterKey]); // filterKey intentionally captures a semantic snapshot

  const loadMore = useCallback(async () => {
    if (!page.has_more || !page.next_cursor || loadingMore) return;
    const projectRevision = guard.current.select(projectId);
    setLoadingMore(true);
    try {
      const result = await client.listItems(projectId, filters, { cursor: page.next_cursor });
      if (!guard.current.isCurrent(projectId, projectRevision)) return;
      setItems((current) => {
        const seen = new Set(current.map((record) => record.item.id));
        const next = [...current, ...result.items.filter((record) => !seen.has(record.item.id))];
        hasItems.current = next.length > 0;
        return next;
      });
      setPage(result.page);
      setPartialLiveError(null);
      setRefreshedAt(new Date());
    } catch (cause) {
      if (guard.current.isCurrent(projectId, projectRevision)) setPartialLiveError(errorMessage(cause));
    } finally {
      if (guard.current.isCurrent(projectId, projectRevision)) setLoadingMore(false);
    }
  }, [client, projectId, filterKey, page.has_more, page.next_cursor, loadingMore]);

  useEffect(() => {
    setItems([]);
    hasItems.current = false;
    setPage({ row_count: 0, has_more: false });
    setError(null);
    void load(false);
    const channel = supabase?.channel(`tenbo-project-version-${projectId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'tenbo_projects', filter: `id=eq.${projectId}`,
      }, () => void load(true))
      .subscribe();
    const timer = window.setInterval(() => void load(true), LIVE_REFRESH_FALLBACK_MS);
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      if (channel && supabase) void supabase.removeChannel(channel);
      requestRevision.current += 1;
    };
  }, [projectId, filterKey, load, supabase]);

  return { items, page, loading, loadingMore, error, partialLiveError, refreshedAt, reload: () => load(false), loadMore };
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
