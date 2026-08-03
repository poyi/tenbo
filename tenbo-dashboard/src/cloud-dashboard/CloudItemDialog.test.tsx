import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActiveClaimDto, ItemRecordDto } from '../contracts/tenbo';
import { advisoryFileOverlaps, CloudItemDialog } from './CloudItemDialog';
import type { CloudDashboardClient } from './client';

const record: ItemRecordDto = {
  scope_id: 'cross-cutting', version: '4', archived: false,
  item: { id: 'x-94', title: 'Hosted roadmap', status: 'now', description: 'Shared truth', files_to_read: ['./src/app.ts', 'src/auth.ts'] },
};

describe('CloudItemDialog coordination and keyboard behavior', () => {
  it('keeps file overlap advisory and excludes the authoritative same-item lease', () => {
    const claims: ActiveClaimDto[] = [
      { item_id: 'x-94', owner: 'other', fencing_token: 4, version: 1, expires_at: future(), scope_id: 'cross-cutting', item_title: 'same', files_to_read: ['src/app.ts'] },
      { item_id: 'x-95', owner: 'agent-2', fencing_token: 8, version: 1, expires_at: future(), scope_id: 'cross-cutting', item_title: 'cutover', files_to_read: ['src/app.ts', 'docs/runbook.md'] },
    ];
    expect(advisoryFileOverlaps(record, claims)).toEqual([{ itemId: 'x-95', owner: 'agent-2', files: ['src/app.ts'] }]);
  });

  it('traps keyboard focus, closes on Escape, and restores focus to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const client = {
      getItem: vi.fn(async () => record),
      getItemClaim: vi.fn(async () => null),
      listActiveClaims: vi.fn(async () => ({ claims: [], page: { row_count: 0, has_more: false } })),
      history: vi.fn(async () => ({ entries: [], page: { row_count: 0, has_more: false } })),
      command: vi.fn(),
    } as unknown as CloudDashboardClient;
    const view = render(<CloudItemDialog client={client} projectId="project-1" initial={record} userId="user-1" role="viewer" onClose={onClose} onChanged={() => {}} />);
    const close = await screen.findByRole('button', { name: 'Close item' });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Refresh item' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

function future(): string { return new Date(Date.now() + 60_000).toISOString(); }
