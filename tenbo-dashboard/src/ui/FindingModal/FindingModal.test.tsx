import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingModal } from './index';
import type { Finding } from '../../api/lib/health/types';

const finding: Finding = {
  id: 'editor.hotspot-files.foo', signal: 'hotspot-files', severity: 'critical',
  confidence: 'high', layer: 'visual-canvas', target: 'apps/editor/src/foo.ts',
  headline: 'foo.ts (1500 LOC)',
  suggestion: { summary: 'Split foo.ts', rationale: 'Too big.', action_kind: 'split-file' },
  details: { kind: 'hotspot-files', loc: 1500, top_functions: [], commits_30d: 5, split_candidates: [] },
};

describe('FindingModal', () => {
  it('renders nothing when finding is null', () => {
    const { container } = render(<FindingModal finding={null} allFindings={[]} onClose={vi.fn()} onOpenFile={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders headline, target, suggestion summary, and rationale', () => {
    render(<FindingModal finding={finding} allFindings={[finding]} onClose={vi.fn()} onOpenFile={vi.fn()} />);
    expect(screen.getByText(/foo\.ts \(1500 LOC\)/)).toBeInTheDocument();
    expect(screen.getByText(/apps\/editor\/src\/foo\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/Split foo\.ts/)).toBeInTheDocument();
    expect(screen.getByText(/Too big\./)).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<FindingModal finding={finding} allFindings={[finding]} onClose={onClose} onOpenFile={vi.fn()} />);
    const backdrop = document.querySelector('.overlay-backdrop');
    expect(backdrop).not.toBeNull();
    (backdrop as HTMLElement).click();
    expect(onClose).toHaveBeenCalled();
  });
});
