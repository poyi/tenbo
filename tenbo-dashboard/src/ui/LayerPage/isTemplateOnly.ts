// Returns true when a markdown file contains only template scaffolding
// (HTML comments, headings, dangling section labels like "- **Upstream:**", and
// the migration's "created — initial intent draft" marker bullet). Once an
// agent populates real prose anywhere in the file, this returns false.
const SCAFFOLDING_PATTERNS: RegExp[] = [
  /^#{1,6}\s/,                            // headings
  /^-\s*$/,                               // bare list markers
  /^-\s+\*\*[^*]+:\*\*\s*$/,              // "- **Label:**" with no body
  /^-\s+\d{4}-\d{2}-\d{2}:\s*created\b/,  // migration's "initial intent draft" marker
];

export function isTemplateOnly(source: string): boolean {
  const stripped = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return stripped.every((l) => SCAFFOLDING_PATTERNS.some((re) => re.test(l)));
}
