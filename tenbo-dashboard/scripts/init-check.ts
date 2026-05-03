/**
 * init-check.ts — strict variant of validate, used by the skill at the end of
 * the Initialize Project Memory flow.
 *
 * Reuses the standard validator, then upgrades or adds checks that catch
 * silent init failures (missing skeleton docs, glob mistakes producing
 * `file_count: 0`, missing principles.md/glossary.md, missing metrics.json).
 *
 * Exit codes:
 *   0 — every init artifact is present and structurally sound
 *   1 — at least one init defect found
 *   2 — could not locate repo root
 */
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '../src/api/lib/repoRoot';
import { readState } from '../src/api/lib/tenboFs';
import { validate } from '../src/api/lib/validator';

interface InitDefect {
  message: string;
  scope?: string;
  layerId?: string;
}

export function runInitCheck(repoRoot: string): { defects: InitDefect[]; preExistingErrors: number } {
  const defects: InitDefect[] = [];
  const tenbo = path.join(repoRoot, '.tenbo');

  // Repo-level files
  if (!fs.existsSync(path.join(tenbo, 'workspace.yaml'))) {
    defects.push({ message: 'missing .tenbo/workspace.yaml' });
  }
  if (!fs.existsSync(path.join(tenbo, 'principles.md'))) {
    defects.push({ message: 'missing .tenbo/principles.md (init step 8 — write from template)' });
  }
  if (!fs.existsSync(path.join(tenbo, 'glossary.md'))) {
    defects.push({ message: 'missing .tenbo/glossary.md (init step 8 — write from template)' });
  }

  const state = readState(repoRoot);

  // Per-scope and per-layer
  for (const scope of state.scopes) {
    const scopeDir = path.join(tenbo, 'scopes', scope.id);
    const metricsPath = path.join(scopeDir, 'metrics.json');

    if (!fs.existsSync(metricsPath)) {
      defects.push({
        message: `scope "${scope.id}" missing metrics.json — run "npx tenbo-dashboard metrics --all"`,
        scope: scope.id,
      });
    } else {
      // Check for the silent glob bug: file_count: 0 in a scope that obviously has files.
      try {
        const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
        const layers = metrics?.layers ?? {};
        // Quick file existence check on the scope path
        const scopeRoot = path.resolve(repoRoot, scope.path ?? '.');
        const scopeHasFiles = fs.existsSync(scopeRoot) && fs.readdirSync(scopeRoot).length > 0;
        for (const [layerId, m] of Object.entries(layers) as [string, { file_count?: number }][]) {
          if (scopeHasFiles && (m.file_count ?? 0) === 0) {
            defects.push({
              message: `layer "${layerId}" has file_count: 0 despite scope "${scope.id}" containing files — likely a glob path mistake. Globs in architecture.yaml are RELATIVE to scope.path (not the repo root). See architecture.yaml.tmpl header comment.`,
              scope: scope.id,
              layerId,
            });
          }
        }
      } catch (e) {
        defects.push({
          message: `scope "${scope.id}" metrics.json is unreadable: ${(e as Error).message}`,
          scope: scope.id,
        });
      }
    }

    for (const layer of scope.layers) {
      const docs = state.layerDocs?.[`${scope.id}/${layer.id}`];
      if (!docs?.hasIntent) {
        defects.push({
          message: `layer "${layer.id}" missing intent.md (init step 8 — write skeleton from template)`,
          scope: scope.id,
          layerId: layer.id,
        });
      }
      if (!docs?.hasCodeMap) {
        defects.push({
          message: `layer "${layer.id}" missing code-map.md (init step 8 — write skeleton from template)`,
          scope: scope.id,
          layerId: layer.id,
        });
      }
    }
  }

  // Reuse standard validator for everything else; treat its errors as defects.
  const result = validate(state);
  for (const e of result.errors) {
    defects.push({ message: e.message, scope: e.scope, layerId: e.layerId });
  }

  return { defects, preExistingErrors: result.errors.length };
}

function isMain(): boolean {
  try {
    const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
    const here = path.resolve(new URL(import.meta.url).pathname);
    return invoked === here;
  } catch {
    return false;
  }
}

if (isMain()) {
  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    process.stderr.write('init-check: unable to find repo root (no .tenbo/ in any parent directory)\n');
    process.exit(2);
  }
  const { defects } = runInitCheck(repoRoot);
  if (defects.length === 0) {
    process.stdout.write('init-check: all init artifacts present.\n');
    process.exit(0);
  }
  process.stderr.write(`init-check FAILED — ${defects.length} init defect(s):\n`);
  for (const d of defects) {
    const loc = d.scope ? ` [${d.scope}${d.layerId ? `/${d.layerId}` : ''}]` : '';
    process.stderr.write(`  ❌${loc} ${d.message}\n`);
  }
  process.exit(1);
}
