import { describe, it, expect } from 'vitest';
import { parseYaml, stringifyYaml, patchSeqItem, reorderSeqItems } from '../../src/api/lib/yamlOrdered';

const SAMPLE = `# header comment
items:
  - id: rm-001
    title: First
    status: now
  - id: rm-002
    title: Second
    status: later
`;

describe('yamlOrdered', () => {
  it('round-trips comments', () => {
    const doc = parseYaml(SAMPLE);
    const out = stringifyYaml(doc);
    expect(out).toContain('# header comment');
  });

  it('patches a single field on a sequence item by id', () => {
    const doc = parseYaml(SAMPLE);
    patchSeqItem(doc, 'items', 'rm-001', { status: 'done' });
    const out = stringifyYaml(doc);
    expect(out).toMatch(/rm-001[\s\S]*status: done/);
    expect(out).toMatch(/# header comment/);
  });

  it('reorders sequence items by id list', () => {
    const doc = parseYaml(SAMPLE);
    reorderSeqItems(doc, 'items', ['rm-002', 'rm-001']);
    const out = stringifyYaml(doc);
    const i1 = out.indexOf('rm-002');
    const i2 = out.indexOf('rm-001');
    expect(i1).toBeLessThan(i2);
  });
});
