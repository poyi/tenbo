import { describe, it, expect } from 'vitest';
import { isTemplateOnly } from './isTemplateOnly';

describe('isTemplateOnly', () => {
  it('returns true for empty input', () => {
    expect(isTemplateOnly('')).toBe(true);
    expect(isTemplateOnly('   \n\n  ')).toBe(true);
  });
  it('returns true for headings + html comments only', () => {
    const tpl = `# layer\n\n## Purpose\n<!-- One paragraph. -->\n\n## Responsibilities\n- <!-- Verb phrases. -->\n`;
    expect(isTemplateOnly(tpl)).toBe(true);
  });
  it('returns true for the migration scaffolding template', () => {
    const tpl = `# property-editor

## Purpose
<!-- One paragraph. Why this layer exists. The user-facing job it does. -->

## Responsibilities
- <!-- Verb phrases. ≤ 7 items. -->

## Boundaries
- **Upstream (depends on):** <!-- layers and what's consumed -->
- **Downstream (depended on by):** <!-- layers and what's provided -->
- **External:** <!-- libraries/services and roles -->

## Boundary decisions
<!-- Newest first. -->
- 2026-04-26: created — initial intent draft.
`;
    expect(isTemplateOnly(tpl)).toBe(true);
  });
  it('returns false when real prose is present', () => {
    const real = `# layer\n\n## Purpose\nThis layer renders the canvas tree.\n`;
    expect(isTemplateOnly(real)).toBe(false);
  });
  it('returns false when a list item has real content', () => {
    const real = `# layer\n\n## Responsibilities\n- Render nodes.\n- Persist edits.\n`;
    expect(isTemplateOnly(real)).toBe(false);
  });
  it('returns false when an Upstream bullet has been filled in', () => {
    const real = `# layer\n\n## Boundaries\n- **Upstream (depends on):** Tokens & Themes.\n`;
    expect(isTemplateOnly(real)).toBe(false);
  });
});
