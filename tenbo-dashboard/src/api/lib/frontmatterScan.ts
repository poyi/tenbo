import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { RelatedDoc } from '../../types';

const DEFAULT_DIRS = ['docs/superpowers/plans', 'docs/superpowers/specs'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile() && full.endsWith('.md')) out.push(full);
  }
  return out;
}

export function scanForRelated(repoRoot: string, extraDirs: string[] = []): RelatedDoc[] {
  const dirs = [...DEFAULT_DIRS, ...extraDirs].map(d => path.join(repoRoot, d));
  const files = dirs.flatMap(d => walk(d));
  const out: RelatedDoc[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const parsed = matter(text);
    const itemId = parsed.data?.tenbo_item;
    if (typeof itemId === 'string') {
      const titleMatch = parsed.content.match(/^#\s+(.+)$/m);
      out.push({
        path: path.relative(repoRoot, file),
        itemId,
        title: titleMatch?.[1]?.trim(),
      });
    }
  }
  return out;
}
