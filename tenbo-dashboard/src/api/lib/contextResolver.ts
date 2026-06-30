import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { readLayerContent, readState } from './tenboFs';
import { comparePriority } from './priority';
import { checkSourceIndexFreshness, readSourceIndex } from './sourceIndex/store';
import { querySourceIndex, type SourceEvidenceFile } from './sourceIndex/query';
import type { Item, Layer, Scope, Status } from '../../types';

export type ContextIntent = 'session' | 'feature' | 'item';
export type ContextConfidence = 'high' | 'medium' | 'low';

export interface ContextWarning {
  kind:
    | 'missing_agent_context'
    | 'stale_agent_context'
    | 'missing_source_index'
    | 'stale_source_index'
    | 'corrupt_source_index'
    | 'incompatible_source_index';
  message: string;
  path: string;
  age_days?: number;
}

export interface ContextItemSummary {
  id: string;
  title: string;
  status: Status;
  description: string;
  layer?: string;
  layers?: string[];
  affects?: string[];
  type?: Item['type'];
  priority?: Item['priority'];
  goal_ref?: Item['goal_ref'];
  files_to_read?: string[];
  done_when?: string[];
  risks?: string[];
}

export interface ContextItemEntry {
  scope: string;
  item: ContextItemSummary;
  score: number;
}

export type ContextReadPlanKind =
  | 'product'
  | 'layer-intent'
  | 'layer-code-map'
  | 'roadmap-item'
  | 'source-file'
  | 'spec';

export interface ContextReadPlanEntry {
  path: string;
  kind: ContextReadPlanKind;
  reason: string;
  priority: number;
}

export interface ContextVerificationEntry {
  command: string;
  purpose: string;
  when: string;
}

export interface ContextLayerEntry {
  scope: string;
  id: string;
  name: string;
  score: number;
}

export interface ContextScopeEntry {
  id: string;
  path: string;
  description: string;
  score: number;
}

export interface FeatureContextBundle {
  ok: true;
  intent: 'feature';
  query: string;
  product: {
    goals: Array<{ id: string; text: string }>;
    non_goals: string[];
  };
  recommendation: {
    confidence: ContextConfidence;
    scope: string | null;
    layers: string[];
    goal_refs: string[];
  };
  candidates: {
    scopes: ContextScopeEntry[];
    layers: ContextLayerEntry[];
  };
  roadmap: {
    active_items: ContextItemEntry[];
    matching_items: ContextItemEntry[];
    next_items: ContextItemEntry[];
  };
  context: {
    layer_docs: string[];
    files_to_read: string[];
    read_plan: ContextReadPlanEntry[];
    verification_plan: ContextVerificationEntry[];
  };
  warnings: ContextWarning[];
}

interface ResolveOptions {
  now?: Date;
}

interface Goal {
  id: string;
  text: string;
}

interface ScoredLayer {
  scope: Scope;
  layer: Layer;
  score: number;
}

interface ScoredItemEntry {
  scope: string;
  item: Item;
  score: number;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'build',
  'can',
  'for',
  'from',
  'help',
  'how',
  'i',
  'in',
  'into',
  'is',
  'it',
  'me',
  'of',
  'on',
  'or',
  'our',
  'the',
  'this',
  'to',
  'we',
  'with',
]);

const ACTIVE_STATUSES: readonly Status[] = ['now'];
const NEXT_STATUSES: readonly Status[] = ['now', 'next'];

function tenboDir(repoRoot: string): string {
  return path.join(repoRoot, '.tenbo');
}

function repoRelative(...parts: string[]): string {
  return path.join(...parts).split(path.sep).join('/');
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  let score = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) score += 1;
  }
  return score;
}

function parseGoals(overviewMd: string): Goal[] {
  const goals: Goal[] = [];
  const section = overviewMd.match(/## Product goals\s+([\s\S]*?)(?:\n## |\s*$)/i)?.[1] ?? '';
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\*\*(g\d+)\*\*:\s*(.+)$/i);
    if (match) goals.push({ id: match[1], text: match[2].trim() });
  }
  return goals;
}

function parseNonGoals(overviewMd: string): string[] {
  const section = overviewMd.match(/## Non-goals\s+([\s\S]*?)(?:\n## |\s*$)/i)?.[1] ?? '';
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function itemText(item: Item): string {
  return [
    item.id,
    item.title,
    item.layer,
    ...(item.layers ?? []),
    item.description,
    ...(item.done_when ?? []),
    ...(item.files_to_read ?? []),
    ...(item.risks ?? []),
  ].filter(Boolean).join(' ');
}

function layerText(repoRoot: string, scope: Scope, layer: Layer): string {
  const content = readLayerContent(repoRoot, scope.id, layer.id);
  return [
    scope.id,
    scope.path,
    scope.description,
    layer.id,
    layer.name,
    layer.description,
    ...(layer.files ?? []),
    content.readme,
    content.intentMd,
    content.codeMapMd,
  ].join(' ');
}

function itemLayerIds(item: Item): string[] {
  return [item.layer, ...(item.layers ?? []), ...(item.affects ?? [])].filter((value): value is string => Boolean(value));
}

function itemBoostForLayer(scope: Scope, layer: Layer, matchingItems: ScoredItemEntry[]): number {
  let boost = 0;
  for (const entry of matchingItems) {
    if (entry.scope !== scope.id) continue;
    for (const layerRef of itemLayerIds(entry.item)) {
      const [refScope, refLayer] = layerRef.includes(':') ? layerRef.split(':', 2) : [scope.id, layerRef];
      if (refScope === scope.id && refLayer === layer.id) boost += entry.score * 2;
    }
  }
  return boost;
}

function scoreLayers(repoRoot: string, queryTokens: Set<string>, scopes: Scope[], matchingItems: ScoredItemEntry[]): ScoredLayer[] {
  const scored: ScoredLayer[] = [];
  for (const scope of scopes) {
    for (const layer of scope.layers) {
      scored.push({
        scope,
        layer,
        score: overlapScore(queryTokens, layerText(repoRoot, scope, layer)) + itemBoostForLayer(scope, layer, matchingItems),
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.scope.id.localeCompare(b.scope.id) || a.layer.id.localeCompare(b.layer.id));
}

function scoreItems(queryTokens: Set<string>, scopes: Scope[]): ScoredItemEntry[] {
  const out: ScoredItemEntry[] = [];
  for (const scope of scopes) {
    for (const item of scope.items) {
      const score = overlapScore(queryTokens, itemText(item));
      if (score > 0) out.push({ scope: scope.id, item, score });
    }
  }
  return out.sort((a, b) => b.score - a.score || comparePriority(a.item, b.item) || a.item.id.localeCompare(b.item.id));
}

function summarizeItem(item: Item, detail: 'brief' | 'execution'): ContextItemSummary {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    description: item.description,
    ...(item.layer ? { layer: item.layer } : {}),
    ...(item.layers ? { layers: item.layers } : {}),
    ...(item.affects ? { affects: item.affects } : {}),
    ...(item.type ? { type: item.type } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
    ...(item.goal_ref ? { goal_ref: item.goal_ref } : {}),
    ...(item.files_to_read ? { files_to_read: item.files_to_read } : {}),
    ...(detail === 'execution' && item.done_when ? { done_when: item.done_when } : {}),
    ...(detail === 'execution' && item.risks ? { risks: item.risks } : {}),
  };
}

function publicItemEntry(entry: ScoredItemEntry, detail: 'brief' | 'execution'): ContextItemEntry {
  return {
    scope: entry.scope,
    item: summarizeItem(entry.item, detail),
    score: entry.score,
  };
}

function goalRefsForItem(item: Item): string[] {
  if (!item.goal_ref || item.goal_ref === 'exploratory') return [];
  return item.goal_ref;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function pushReadPlan(
  entries: ContextReadPlanEntry[],
  seen: Set<string>,
  entry: ContextReadPlanEntry,
) {
  if (seen.has(entry.path)) return;
  seen.add(entry.path);
  entries.push(entry);
}

function buildReadPlan(args: {
  layerDocs: string[];
  activeItems: ScoredItemEntry[];
  matchingItems: ScoredItemEntry[];
  sourceEvidence: SourceEvidenceFile[];
  filesToRead: string[];
}): ContextReadPlanEntry[] {
  const entries: ContextReadPlanEntry[] = [];
  const seen = new Set<string>();
  pushReadPlan(entries, seen, {
    path: '.tenbo/overview.md',
    kind: 'product',
    reason: 'Product goals and non-goals frame the request',
    priority: 1,
  });
  for (const doc of args.layerDocs) {
    pushReadPlan(entries, seen, {
      path: doc,
      kind: doc.endsWith('/intent.md') ? 'layer-intent' : 'layer-code-map',
      reason: 'Selected layer context for the request',
      priority: entries.length + 1,
    });
  }
  for (const source of args.sourceEvidence) {
    pushReadPlan(entries, seen, {
      path: source.path,
      kind: 'source-file',
      reason: source.reason,
      priority: entries.length + 1,
    });
  }
  for (const entry of [...args.activeItems, ...args.matchingItems]) {
    for (const link of entry.item.links ?? []) {
      pushReadPlan(entries, seen, {
        path: link,
        kind: 'spec',
        reason: `Linked plan/spec for ${entry.item.id}`,
        priority: entries.length + 1,
      });
    }
  }
  for (const file of args.filesToRead) {
    pushReadPlan(entries, seen, {
      path: file,
      kind: file.startsWith('.tenbo/') ? 'roadmap-item' : 'source-file',
      reason: 'Referenced by active or matching roadmap context',
      priority: entries.length + 1,
    });
  }
  return entries.slice(0, 12).map((entry, index) => ({ ...entry, priority: index + 1 }));
}

function buildVerificationPlan(): ContextVerificationEntry[] {
  return [
    {
      command: 'node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json',
      purpose: 'Check Tenbo roadmap and documentation structure',
      when: 'after changing .tenbo files',
    },
    {
      command: 'cd tenbo-dashboard && npm test -- --run',
      purpose: 'Run dashboard and CLI unit tests',
      when: 'after changing dashboard code',
    },
  ];
}

function confidenceForScore(score: number): ContextConfidence {
  if (score >= 3) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function scopeCandidates(scopes: Scope[], scoredLayers: ScoredLayer[], matchingItems: ScoredItemEntry[]): ContextScopeEntry[] {
  return scopes.map((scope) => {
    const layerScore = scoredLayers
      .filter((entry) => entry.scope.id === scope.id)
      .reduce((sum, entry) => sum + entry.score, 0);
    const itemScore = matchingItems
      .filter((entry) => entry.scope === scope.id)
      .reduce((sum, entry) => sum + entry.score, 0);
    return {
      id: scope.id,
      path: scope.path,
      description: scope.description,
      score: layerScore + itemScore,
    };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function withSourceScopeScores(candidates: ContextScopeEntry[], sourceScores: Map<string, number>): ContextScopeEntry[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: candidate.score + (sourceScores.get(candidate.id) ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function withSourceLayerScores(scoredLayers: ScoredLayer[], sourceScores: Map<string, number>): ScoredLayer[] {
  return scoredLayers
    .map((entry) => ({
      ...entry,
      score: entry.score + (sourceScores.get(`${entry.scope.id}:${entry.layer.id}`) ?? 0),
    }))
    .sort((a, b) => b.score - a.score || a.scope.id.localeCompare(b.scope.id) || a.layer.id.localeCompare(b.layer.id));
}

function roadmapEntriesForScope(scope: Scope, statuses: readonly Status[]): ScoredItemEntry[] {
  return scope.items
    .filter((item) => statuses.includes(item.status))
    .map((item) => ({ scope: scope.id, item, score: 0 }))
    .sort((a, b) => comparePriority(a.item, b.item) || a.item.id.localeCompare(b.item.id));
}

function agentContextWarnings(repoRoot: string, now: Date): ContextWarning[] {
  const contextPath = path.join(tenboDir(repoRoot), 'agent-context.md');
  const relPath = '.tenbo/agent-context.md';
  if (!existsSync(contextPath)) {
    return [{ kind: 'missing_agent_context', path: relPath, message: 'agent context digest is missing' }];
  }
  const ageDays = Math.floor((now.getTime() - statSync(contextPath).mtimeMs) / 86_400_000);
  if (ageDays > 7) {
    return [{
      kind: 'stale_agent_context',
      path: relPath,
      age_days: ageDays,
      message: `agent context digest is ${ageDays} days old`,
    }];
  }
  return [];
}

function sourceIndexWarning(freshness: ReturnType<typeof checkSourceIndexFreshness>): ContextWarning | null {
  if (freshness.status === 'fresh') return null;
  const kindByStatus: Record<string, ContextWarning['kind']> = {
    missing: 'missing_source_index',
    stale: 'stale_source_index',
    corrupt: 'corrupt_source_index',
    incompatible: 'incompatible_source_index',
  };
  const kind = kindByStatus[freshness.status];
  if (!kind) return null;
  return {
    kind,
    path: '.tenbo/cache/source-index.json',
    message: freshness.message,
  };
}

export function resolveFeatureContext(repoRoot: string, query: string, opts: ResolveOptions = {}): FeatureContextBundle {
  const now = opts.now ?? new Date();
  const state = readState(repoRoot);
  const queryTokens = tokenize(query);
  const goals = parseGoals(state.workspaceContent.overviewMd);
  const nonGoals = parseNonGoals(state.workspaceContent.overviewMd);
  const sourceIndex = readSourceIndex(repoRoot);
  const sourceFreshness = checkSourceIndexFreshness(repoRoot, sourceIndex);
  const sourceQuery = sourceFreshness.status === 'fresh' && sourceIndex
    ? querySourceIndex(sourceIndex, query)
    : null;
  const matchingItems = scoreItems(queryTokens, state.scopes);
  const scoredLayers = withSourceLayerScores(
    scoreLayers(repoRoot, queryTokens, state.scopes, matchingItems),
    sourceQuery?.layerScores ?? new Map(),
  );
  const candidates = withSourceScopeScores(
    scopeCandidates(state.scopes, scoredLayers, matchingItems),
    sourceQuery?.scopeScores ?? new Map(),
  );
  const topScope = candidates[0];
  const confidence = confidenceForScore(topScope?.score ?? 0);
  const selectedScope = confidence === 'low'
    ? null
    : state.scopes.find((scope) => scope.id === topScope.id) ?? null;
  const scopedLayers = selectedScope
    ? scoredLayers.filter((entry) => entry.scope.id === selectedScope.id && entry.score > 0)
    : [];
  const topLayer = scopedLayers[0];
  const selectedLayers = selectedScope
    ? scopedLayers
      .filter((entry) => entry.score === topLayer?.score)
      .slice(0, 3)
      .map((entry) => entry.layer.id)
    : [];
  const activeItems = selectedScope ? roadmapEntriesForScope(selectedScope, ACTIVE_STATUSES) : [];
  const nextItems = selectedScope ? roadmapEntriesForScope(selectedScope, NEXT_STATUSES) : [];
  const goalRefs = unique([
    ...activeItems.flatMap((entry) => goalRefsForItem(entry.item)),
    ...matchingItems.flatMap((entry) => goalRefsForItem(entry.item)),
    ...goals
      .map((goal) => ({ goal, score: overlapScore(queryTokens, goal.text) }))
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.goal.id),
  ]);
  const layerDocs = selectedScope
    ? selectedLayers.flatMap((layerId) => [
      repoRelative('.tenbo', 'scopes', selectedScope.id, 'layers', layerId, 'intent.md'),
      repoRelative('.tenbo', 'scopes', selectedScope.id, 'layers', layerId, 'code-map.md'),
    ])
    : [];
  const layerFiles = selectedScope
    ? selectedScope.layers
      .filter((layer) => selectedLayers.includes(layer.id))
      .flatMap((layer) => layer.files ?? [])
    : [];
  const filesToRead = unique([
    ...layerFiles,
    ...activeItems.flatMap((entry) => entry.item.files_to_read ?? []),
    ...matchingItems.flatMap((entry) => entry.item.files_to_read ?? []),
  ]);
  const sourceEvidence = (sourceQuery?.files ?? [])
    .filter((entry) => !selectedScope || entry.scope === selectedScope.id)
    .filter((entry) => selectedLayers.length === 0 || entry.layers.some((layer) => selectedLayers.includes(layer)));
  const readPlan = buildReadPlan({
    layerDocs,
    activeItems,
    matchingItems,
    sourceEvidence,
    filesToRead,
  });
  const sourceWarning = sourceIndexWarning(sourceFreshness);

  return {
    ok: true,
    intent: 'feature',
    query,
    product: { goals, non_goals: nonGoals },
    recommendation: {
      confidence,
      scope: selectedScope?.id ?? null,
      layers: selectedLayers,
      goal_refs: goalRefs,
    },
    candidates: {
      scopes: candidates,
      layers: scoredLayers.slice(0, 5).map((entry) => ({
        scope: entry.scope.id,
        id: entry.layer.id,
        name: entry.layer.name,
        score: entry.score,
      })),
    },
    roadmap: {
      active_items: activeItems.map((entry) => publicItemEntry(entry, 'execution')),
      matching_items: matchingItems.slice(0, 5).map((entry) => publicItemEntry(entry, 'brief')),
      next_items: nextItems.map((entry) => publicItemEntry(entry, 'execution')),
    },
    context: {
      layer_docs: layerDocs,
      files_to_read: filesToRead,
      read_plan: readPlan,
      verification_plan: buildVerificationPlan(),
    },
    warnings: [
      ...agentContextWarnings(repoRoot, now),
      ...(sourceWarning ? [sourceWarning] : []),
    ],
  };
}
