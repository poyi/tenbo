import { describe, it, expect } from 'vitest';
import { analyzeCoupling } from './coupling';
import type { ImportGraph } from './importGraph';

const stubGraph = (edges: Record<string, string[]>): ImportGraph => ({
  importsFrom: (f) => edges[f] ?? [],
  importedBy: () => [],
  allFiles: () => Object.keys(edges),
});

describe('analyzeCoupling', () => {
  it("flags imports that reach into another layer's internals", () => {
    const filesByLayer = {
      A: ['apps/editor/src/A/foo.ts'],
      B: ['apps/editor/src/B/index.ts', 'apps/editor/src/B/internal.ts'],
    };
    const graph = stubGraph({
      'apps/editor/src/A/foo.ts': ['apps/editor/src/B/internal.ts'],
    });
    const findings = analyzeCoupling(filesByLayer, graph);
    expect(findings).toHaveLength(1);
    expect(findings[0].layer).toBe('A');
    expect(findings[0].details.kind).toBe('coupling');
    if (findings[0].details.kind === 'coupling') {
      expect(findings[0].details.crosses_public_api).toBe(false);
    }
  });

  it("does not flag imports that go through layer's index.ts (public API)", () => {
    const filesByLayer = {
      A: ['apps/editor/src/A/foo.ts'],
      B: ['apps/editor/src/B/index.ts'],
    };
    const graph = stubGraph({
      'apps/editor/src/A/foo.ts': ['apps/editor/src/B/index.ts'],
    });
    const findings = analyzeCoupling(filesByLayer, graph);
    expect(findings).toEqual([]);
  });
});
