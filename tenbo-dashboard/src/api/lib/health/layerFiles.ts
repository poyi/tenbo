import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Scope } from '../../../types';
import { globMatches } from '../metrics';

/**
 * Returns a map of layerId -> array of repo-relative file paths.
 */
export function resolveLayerFiles(repoRoot: string, scope: Scope): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const root = path.resolve(repoRoot, scope.path);
  for (const layer of scope.layers) out[layer.id] = [];
  if (!existsSync(root)) return out;

  function walk(dir: string) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries.sort()) {
      const full = path.join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else {
        const relToScope = path.relative(root, full).split(path.sep).join('/');
        const relToRepo = path.relative(repoRoot, full).split(path.sep).join('/');
        for (const layer of scope.layers) {
          const globs = layer.files ?? [];
          if (globs.some(g => globMatches(g, relToScope))) {
            out[layer.id].push(relToRepo);
          }
        }
      }
    }
  }
  walk(root);
  return out;
}
