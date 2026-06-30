import { execFileSync } from 'node:child_process';
import { readState } from './tenboFs';
import { resolveLayerFiles } from './health/layerFiles';
import { checkSourceIndexFreshness, readSourceIndex } from './sourceIndex/store';
import type { Item, Status } from '../../types';

export interface ImpactGitSummary {
  compared_ref?: string;
  changed_files: string[];
  sources: string[];
  warnings: string[];
}

export interface ImpactLayerSummary {
  scope: string;
  layer: string;
  changed_files: string[];
}

export interface ImpactRelatedItem {
  id: string;
  scope: string;
  title: string;
  reason: string;
}

export interface ImpactSummary extends ImpactGitSummary {
  ok: true;
  affected_layers: ImpactLayerSummary[];
  stale_docs: string[];
  uncovered_files: string[];
  related_items: ImpactRelatedItem[];
  recommended_checks: string[];
}

function gitLines(repoRoot: string, args: string[]): string[] {
  const out = execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseStatusPath(line: string): string {
  const raw = line[1] === ' ' ? line.slice(2) : line.length > 3 ? line.slice(3) : line;
  const arrow = raw.indexOf(' -> ');
  return arrow === -1 ? raw : raw.slice(arrow + 4);
}

function pushAll(target: Set<string>, values: string[]) {
  for (const value of values) target.add(value);
}

export function collectChangedFiles(repoRoot: string, options: { since?: string } = {}): ImpactGitSummary {
  const changed = new Set<string>();
  const sources = new Set<string>();
  const warnings: string[] = [];
  if (options.since) {
    try {
      pushAll(changed, gitLines(repoRoot, ['diff', '--name-only', `${options.since}...HEAD`]));
      sources.add('since');
    } catch (err) {
      warnings.push(`could not compare against ${options.since}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    pushAll(changed, gitLines(repoRoot, ['diff', '--name-only']));
    sources.add('worktree');
  } catch (err) {
    warnings.push(`could not read unstaged changes: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    pushAll(changed, gitLines(repoRoot, ['diff', '--name-only', '--cached']));
    sources.add('staged');
  } catch (err) {
    warnings.push(`could not read staged changes: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const statusFiles = gitLines(repoRoot, ['status', '--porcelain', '--untracked-files=all']).map(parseStatusPath);
    pushAll(changed, statusFiles);
    sources.add('status');
  } catch (err) {
    warnings.push(`could not read git status: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    ...(options.since ? { compared_ref: options.since } : {}),
    changed_files: Array.from(changed).sort(),
    sources: Array.from(sources).sort(),
    warnings,
  };
}

function itemLayerRefs(item: Item): string[] {
  return [item.layer, ...(item.layers ?? []), ...(item.affects ?? [])].filter((value): value is string => Boolean(value));
}

function itemMatchesLayer(item: Item, scopeId: string, layerId: string): boolean {
  return itemLayerRefs(item).some((ref) => {
    const [refScope, refLayer] = ref.includes(':') ? ref.split(':', 2) : [scopeId, ref];
    return refScope === scopeId && refLayer === layerId;
  });
}

function isActiveStatus(status: Status): boolean {
  return status === 'now';
}

interface RelatedCandidate extends ImpactRelatedItem {
  score: number;
}

function sourceIndexWarning(status: string): string | null {
  if (status === 'fresh') return null;
  return `source index is ${status}; impact used fallback ownership where needed`;
}

export function resolveImpact(repoRoot: string, options: { since?: string } = {}): ImpactSummary {
  const git = collectChangedFiles(repoRoot, options);
  const state = readState(repoRoot);
  const sourceIndex = readSourceIndex(repoRoot);
  const indexFreshness = checkSourceIndexFreshness(repoRoot, sourceIndex);
  const indexWarning = sourceIndexWarning(indexFreshness.status);
  if (indexWarning) git.warnings.push(indexWarning);
  const indexedFiles = new Map((indexFreshness.status === 'fresh' && sourceIndex ? sourceIndex.files : []).map((file) => [file.path, file]));
  const changedSet = new Set(git.changed_files);
  const affected: ImpactLayerSummary[] = [];
  const mapped = new Set<string>();
  const affectedLayerKeys = new Set<string>();

  for (const scope of state.scopes) {
    const filesByLayer = resolveLayerFiles(repoRoot, scope);
    for (const [layerId, files] of Object.entries(filesByLayer)) {
      const indexedChanged = git.changed_files.filter((file) => {
        const entry = indexedFiles.get(file);
        return entry?.scope === scope.id && entry.layers.includes(layerId);
      });
      const changedFiles = Array.from(new Set([
        ...indexedChanged,
        ...files.filter((file) => changedSet.has(file)),
      ])).sort();
      if (changedFiles.length === 0) continue;
      affected.push({ scope: scope.id, layer: layerId, changed_files: changedFiles });
      affectedLayerKeys.add(`${scope.id}:${layerId}`);
      for (const file of changedFiles) mapped.add(file);
    }
  }

  const related = new Map<string, RelatedCandidate>();
  for (const scope of state.scopes) {
    for (const item of scope.items) {
      let score = 0;
      const reasons: string[] = [];
      const explicitFile = (item.files_to_read ?? []).find((file) => changedSet.has(file));
      if (explicitFile) {
        score += 100;
        reasons.push(`files_to_read includes ${explicitFile}`);
      }
      const affectedLayer = Array.from(affectedLayerKeys).find((key) => {
        const [, layerId] = key.split(':', 2);
        return itemMatchesLayer(item, scope.id, layerId);
      });
      if (affectedLayer && isActiveStatus(item.status)) {
        score += 50;
        reasons.push(`active item on affected layer ${affectedLayer}`);
      } else if (affectedLayer && item.status === 'next') {
        score += 10;
        reasons.push(`next item on affected layer ${affectedLayer}`);
      }
      const linkedSpec = (item.links ?? []).find((link) => changedSet.has(link));
      if (linkedSpec) {
        score += 80;
        reasons.push(`linked spec changed ${linkedSpec}`);
      }
      if (score > 0) {
        related.set(item.id, {
          id: item.id,
          scope: scope.id,
          title: item.title,
          reason: reasons.join('; '),
          score,
        });
      }
    }
  }

  const staleDocs = affected
    .map((entry) => `.tenbo/scopes/${entry.scope}/layers/${entry.layer}/code-map.md`)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  return {
    ok: true,
    ...git,
    affected_layers: affected.sort((a, b) => a.scope.localeCompare(b.scope) || a.layer.localeCompare(b.layer)),
    stale_docs: staleDocs,
    uncovered_files: git.changed_files.filter((file) => !mapped.has(file)).sort(),
    related_items: Array.from(related.values())
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 8)
      .map(({ score: _score, ...item }) => item),
    recommended_checks: [
      'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
      'cd tenbo-dashboard && npm test -- --run',
    ],
  };
}
