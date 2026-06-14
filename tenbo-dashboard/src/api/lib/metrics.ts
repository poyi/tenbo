import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { LayerDocs, Scope, ScopeMetrics, LayerMetrics } from '../../types';
import { shouldIgnoreSourceDir } from './sourceIgnore';

function matchGlob(repoRoot: string, scopePath: string, globs: string[]): string[] {
  const root = path.resolve(repoRoot, scopePath);
  const matches: string[] = [];
  if (!existsSync(root)) return matches;
  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!shouldIgnoreSourceDir(entry)) walk(full);
      }
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (globs.some(g => globMatches(g, rel))) matches.push(full);
      }
    }
  }
  walk(root);
  return matches;
}

export function globMatches(glob: string, rel: string): boolean {
  // Convert glob to RegExp. `/**/` collapses to "any number of path segments
  // including zero" so `src/**/*.ts` matches both `src/a.ts` and `src/foo/a.ts`.
  // A leading `**/` similarly collapses, so `**/foo.ts` matches both `foo.ts`
  // (root) and `dir/foo.ts`. Bare `**` becomes `.*`; `*` becomes `[^/]*`.
  // Placeholders protect each transformation from later passes.
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/^\*\*\//, '__LEADGLOBSTAR__')
    .replace(/\/\*\*\//g, '__SLASHGLOBSTARSLASH__')
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__SLASHGLOBSTARSLASH__/g, '(?:/|/.*/)')
    .replace(/__LEADGLOBSTAR__/g, '(?:|.*/)');
  return new RegExp('^' + escaped + '$').test(rel);
}

function lineCount(filePath: string): number {
  const content = readFileSync(filePath, 'utf8');
  if (content.length === 0) return 0;
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
}

export function computeScopeMetrics(
  repoRoot: string,
  scope: Scope,
  layerDocs: Record<string, LayerDocs>,
): ScopeMetrics {
  const layers: Record<string, LayerMetrics> = {};
  for (const layer of scope.layers) {
    const matched = matchGlob(repoRoot, scope.path, layer.files ?? []);
    const totalLines = matched.reduce((sum, f) => sum + lineCount(f), 0);
    const outbound = layer.dependencies?.outbound?.length ?? 0;
    const docs = layerDocs[`${scope.id}/${layer.id}`];
    const intentAgeDays = docs?.intentMtime != null
      ? Math.floor((Date.now() - docs.intentMtime) / (24 * 3600 * 1000))
      : null;
    const layerItems = scope.items.filter(i => i.layer === layer.id || i.layers?.includes(layer.id));
    const nowItems = layerItems.filter(i => i.status === 'now').length;
    const pctNow = layerItems.length === 0 ? 0 : Math.round((nowItems / layerItems.length) * 100);
    layers[layer.id] = {
      file_count: matched.length,
      total_lines: totalLines,
      outbound_deps: outbound,
      deep_dive_count: 0, // populated by readDeepDiveCount when wired up
      intent_age_days: intentAgeDays,
      pct_roadmap_in_now: pctNow,
    };
  }
  return { generated_at: new Date().toISOString(), layers, findings: [] };
}
