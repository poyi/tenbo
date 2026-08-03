import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ItemRecordDto } from '../contracts/tenbo';
import type { CloudDashboardClient } from './client';
import { CloudItemSpecifications } from './CloudItemSpecifications';

const specification = {
  id: '60cb1f17-88f3-4466-af43-65ed2db3933f',
  item_id: 'x-105',
  source_kind: 'planning' as const,
  kind: 'spec' as const,
  path: '.tenbo/specs/x-105-cloud-tenbo.md',
  version: '4',
  archived: false,
  content_hash: 'a'.repeat(64),
  summary: 'Canonical cloud specification.',
  token_estimate: 500,
  content_bytes: 2_000,
};

const record: ItemRecordDto = {
  scope_id: 'cross-cutting', version: '7', archived: false,
  item: { id: 'x-105', title: 'Cloud Tenbo', status: 'now', description: 'Shared planning.' },
  specification,
  specifications: [specification],
};

describe('CloudItemSpecifications', () => {
  it('loads and saves one Markdown section through the claim-fenced typed command', async () => {
    const client = {
      getItemContext: vi.fn(async () => ({
        kind: 'context', intent: 'item',
        payload: {
          specification: {
            id: specification.id, version: '4', section_hash: 'b'.repeat(64),
            blocks: [{ heading_path: ['Implementation'], markdown: '## Implementation\n\nOld body' }],
            structural_bounds: { truncated: false },
          },
        },
        bounds: { row_count: 1, byte_count: 40, token_estimate: 10, estimator: 'tenbo-token-estimator-v1', limits: { rows: 24, bytes: 32_768, tokens: 3_000 }, truncated: false },
      })),
      command: vi.fn(async () => ({ kind: 'document', value: { ...specification, content: '## Implementation\n\nNew body', version: '5' } })),
    } as unknown as CloudDashboardClient;
    const onRefresh = vi.fn(async () => {});
    render(<CloudItemSpecifications client={client} projectId="project-1" record={record} role="editor" ownsClaim fencingToken={12} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    fireEvent.change(screen.getByLabelText('Existing heading'), { target: { value: 'Implementation' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load section' }));
    const editor = await screen.findByLabelText('Section body');
    expect(editor).toHaveValue('Old body');
    fireEvent.change(editor, { target: { value: 'New body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save section' }));

    await waitFor(() => expect(client.command).toHaveBeenCalledWith('project-1', {
      kind: 'replacePlanningDocumentSection',
      document_id: specification.id,
      heading: 'Implementation',
      content: 'New body',
      expected_version: '4',
      expected_section_hash: 'b'.repeat(64),
      fencing_token: 12,
    }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('requires the authoritative item claim before creating a specification', () => {
    const client = { command: vi.fn() } as unknown as CloudDashboardClient;
    const noSpecification = { ...record, specification: undefined, specifications: [] };
    const view = render(<CloudItemSpecifications client={client} projectId="project-1" record={noSpecification} role="editor" ownsClaim={false} onRefresh={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Create specification' })).toBeDisabled();
    view.rerender(<CloudItemSpecifications client={client} projectId="project-1" record={noSpecification} role="editor" ownsClaim fencingToken={9} onRefresh={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Create specification' })).toBeEnabled();
  });
});
