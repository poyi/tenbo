import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ItemFiltersDto } from '../contracts/tenbo';
import type { CloudDashboardClient } from './client';
import { useCloudItems } from './useCloudItems';

describe('useCloudItems live convergence', () => {
  it('refetches the bounded page when the project-version realtime signal arrives', async () => {
    const listItems = vi.fn(async () => ({
      items: [],
      page: { row_count: 0, has_more: false },
    }));
    let onProjectVersion: (() => void) | undefined;
    const channel = {
      on: vi.fn((_kind: string, _filter: unknown, callback: () => void) => {
        onProjectVersion = callback;
        return channel;
      }),
      subscribe: vi.fn(() => channel),
    };
    const removeChannel = vi.fn(async () => 'ok');
    const supabase = { channel: vi.fn(() => channel), removeChannel } as unknown as SupabaseClient;
    const client = { listItems } as unknown as CloudDashboardClient;

    const filters: ItemFiltersDto = { status: ['now', 'next', 'later'], search: 'modal' };
    const { unmount } = renderHook(() => useCloudItems(client, 'project-1', filters, supabase));
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(1));
    expect(listItems).toHaveBeenLastCalledWith('project-1', filters);
    expect(onProjectVersion).toBeTypeOf('function');
    onProjectVersion?.();
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(2));
    expect(listItems).toHaveBeenLastCalledWith('project-1', filters);
    unmount();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });

  it('preserves the selected status filter while loading the next page', async () => {
    const listItems = vi.fn()
      .mockResolvedValueOnce({ items: [], page: { row_count: 50, has_more: true, next_cursor: 'o:50' } })
      .mockResolvedValueOnce({ items: [], page: { row_count: 0, has_more: false } });
    const client = { listItems } as unknown as CloudDashboardClient;
    const filters: ItemFiltersDto = { status: ['now', 'next', 'later'] };

    const { result, unmount } = renderHook(() => useCloudItems(client, 'project-1', filters));
    await waitFor(() => expect(result.current.page.next_cursor).toBe('o:50'));
    await act(async () => { await result.current.loadMore(); });

    expect(listItems).toHaveBeenNthCalledWith(1, 'project-1', filters);
    expect(listItems).toHaveBeenNthCalledWith(2, 'project-1', filters, { cursor: 'o:50' });
    unmount();
  });
});
