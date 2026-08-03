import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
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

    const { unmount } = renderHook(() => useCloudItems(client, 'project-1', {}, supabase));
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(1));
    expect(onProjectVersion).toBeTypeOf('function');
    onProjectVersion?.();
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(2));
    unmount();
    expect(removeChannel).toHaveBeenCalledWith(channel);
  });
});
