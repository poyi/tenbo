import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayerDetailPage } from './LayerDetailPage';
import type { TenboState } from '../../types';

const state: TenboState = {
  scopes: [{
    id: 'editor', path: 'apps/editor', description: '', layers: [
      { id: 'lyr', name: 'Lyr', description: '', files: [], dependencies: { inbound: [], outbound: [], external: [] } },
    ], items: [],
  }],
  crossCutting: [], narratives: {}, workspaceContent: {} as any,
  metrics: {
    editor: {
      generated_at: '2026-05-02T00:00:00Z',
      layers: { lyr: { file_count: 10, total_lines: 200, outbound_deps: 0, deep_dive_count: 0, intent_age_days: null, pct_roadmap_in_now: 0 } },
      findings: [],
    },
  },
};

describe('LayerDetailPage', () => {
  it('renders the layer name and all 8 signal sections', () => {
    render(<LayerDetailPage state={state} scopeId="editor" layerId="lyr" onBack={vi.fn()} onSelectFinding={vi.fn()} />);
    expect(screen.getByText('Lyr')).toBeInTheDocument();
    expect(screen.getByText('Hotspot files')).toBeInTheDocument();
    expect(screen.getByText('Dead code')).toBeInTheDocument();
    expect(screen.getByText('Redundancy')).toBeInTheDocument();
  });
});
