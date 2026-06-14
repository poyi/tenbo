import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HealthPage } from './HealthPage';
import type { TenboState } from '../../types';
import type { Finding } from '../../api/lib/health/types';

const finding = (over: Partial<Finding>): Finding => ({
  id: 'editor.hotspot-files.foo', signal: 'hotspot-files', severity: 'critical',
  confidence: 'high', layer: 'visual-canvas', target: 'apps/editor/src/foo.ts',
  headline: 'foo.ts (1500 LOC)',
  suggestion: { summary: 'Split foo.ts', rationale: '', action_kind: 'split-file' },
  details: { kind: 'hotspot-files', loc: 1500, top_functions: [], commits_30d: 0, split_candidates: [] },
  ...over,
});

const state: TenboState = {
  scopes: [{
    id: 'editor', path: 'apps/editor', description: 'Editor', layers: [
      { id: 'visual-canvas', name: 'Visual Canvas', description: '', files: ['src/**'], dependencies: { inbound: [], outbound: [], external: [] } },
    ],
    items: [],
  }],
  crossCutting: [], narratives: {}, workspaceContent: {} as any,
  metrics: {
    editor: {
      generated_at: '2026-05-02T00:00:00Z',
      layers: { 'visual-canvas': { file_count: 100, total_lines: 5000, outbound_deps: 0, deep_dive_count: 0, intent_age_days: null, pct_roadmap_in_now: 0 } },
      findings: [finding({})],
    },
  },
};

describe('HealthPage', () => {
  it('renders digest section with finding headline', () => {
    render(<HealthPage state={state} onSelectLayer={vi.fn()} onSelectFinding={vi.fn()} />);
    expect(screen.getByText(/foo\.ts \(1500 LOC\)/)).toBeInTheDocument();
  });

  it('renders one layer card per layer', () => {
    render(<HealthPage state={state} onSelectLayer={vi.fn()} onSelectFinding={vi.fn()} />);
    expect(screen.getByText('Visual Canvas')).toBeInTheDocument();
    expect(screen.getByText(/100 files/)).toBeInTheDocument();
  });

  it('does not render the old "limit"-suffix violation messages', () => {
    render(<HealthPage state={state} onSelectLayer={vi.fn()} onSelectFinding={vi.fn()} />);
    expect(screen.queryByText(/\(limit \d+\)/)).toBeNull();
  });

  it('surfaces stale metrics status without hiding cached health data', () => {
    render(
      <HealthPage
        state={{
          ...state,
          metricsStatus: {
            editor: {
              status: 'refreshing',
              generatedAt: '2026-05-02T00:00:00Z',
              message: 'Refreshing health metrics in the background; cached metrics are still being served.',
            },
          },
        }}
        onSelectLayer={vi.fn()}
        onSelectFinding={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Health metrics refreshing');
    expect(screen.getByText('Visual Canvas')).toBeInTheDocument();
  });
});
