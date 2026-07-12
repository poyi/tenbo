import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { readLayerContent, readState } from './tenboFs';
import { comparePriority } from './priority';
import { checkSourceIndexFreshness, readSourceIndex } from './sourceIndex/store';
import { querySourceIndex, type SourceEvidenceFile } from './sourceIndex/query';
import { normalizeNotes } from './notes';
import { validate } from './validator';
import { findItem } from './roadmapStore';
import { doneWhenText } from './doneWhenChecks';
import { isLayerCodeMapStale } from './codeMapGenerator';
import { readPendingReconciliation } from './reconciliationFlag';
import type { Item, Layer, Scope, Status, TenboState } from '../../types';
import type { SourceIndex } from './sourceIndex/types';

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
  done_when?: Item['done_when'];
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

/** Bounded list caps. Documented here since several bundle sections share them. */
const SESSION_LIST_CAP = 12;
const OBSERVATIONS_CAP = 5;
const LAYER_CONSTRAINTS_CAP = 5;

export interface ContextSessionItemRef {
  id: string;
  scope: string;
  title: string;
  /**
   * Days since the item's last recorded activity (workpad `last_updated`, else the
   * most recent dated bullet in `notes:`). `null` when no dated evidence exists —
   * such items are never flagged stale (indeterminate, not fresh).
   */
  days_active: number | null;
}

export interface ContextStaleItemRef extends ContextSessionItemRef {
  days_active: number;
  threshold_days: number;
}

export interface ContextValidationDelta {
  /** `generated_at` of the previous `.tenbo/.validation-status.json` snapshot. */
  generated_at: string;
  previous_errors: number;
  previous_warnings: number;
  current_errors: number;
  current_warnings: number;
  /** Simple count deltas (current − previous, floored at 0) — not identity-diffed. */
  new_errors: number;
  new_warnings: number;
}

export interface ContextWorkpadResumeCandidate {
  item_id: string;
  scope: string;
  title: string;
  workpad: string;
  unchecked_plan_items: number;
}

export interface ContextDocStaleLayerRef {
  scope: string;
  layer: string;
  reason: string;
}

export interface ContextDocStaleness {
  /** Bounded to DOC_STALENESS_CAP. Empty (not omitted) when the source index is missing/stale/corrupt/incompatible — see `warnings` for why. */
  stale_layers: ContextDocStaleLayerRef[];
  /** Total layers considered before capping — 0 when the index couldn't be used. */
  checked_layers: number;
}

export interface ContextPendingReconciliationEntryRef {
  layer: string;
  kind: string;
}

export interface ContextPendingReconciliation {
  /** Total entry count in the ledger (unbounded) — unchanged from the pre-td-036 shape. */
  count: number;
  path: string;
  /**
   * Bounded (PENDING_RECONCILIATION_CAP), deterministically-ordered per-entry
   * `{ layer, kind }` breakdown (td-036) — lets the session briefing say "docs
   * flagged for layers X, Y" without re-reading the YAML. Sorted by layer then
   * kind then opened_at for stability; truncated (not sampled) beyond the cap.
   */
  entries: ContextPendingReconciliationEntryRef[];
}

export interface SessionContextBundle {
  ok: true;
  intent: 'session';
  now: {
    /** Total count of `now` items (unbounded); `items` below is capped. */
    count: number;
    items: ContextSessionItemRef[];
  };
  stale: {
    now: ContextStaleItemRef[];
    next: ContextStaleItemRef[];
  };
  /**
   * `.tenbo/.pending-reconciliation.yaml` summary (td-036). Always present (like
   * `doc_staleness`) — fail-open to `count: 0` + empty `entries` when the file is
   * absent or malformed, rather than throwing or omitting the section.
   */
  pending_reconciliation: ContextPendingReconciliation;
  /** Omitted when `.tenbo/.validation-status.json` is absent or unreadable. */
  validation_delta?: ContextValidationDelta;
  /** Omitted when no item has a workpad with unchecked plan items. */
  workpad_resume?: ContextWorkpadResumeCandidate[];
  /** Omitted when `.tenbo/observations.md` is absent. Bounded to the most recent entries. */
  recent_observations?: string[];
  /**
   * Doc-staleness signal (td-027): layers whose generated `code-map.md`
   * region is stale vs. the current source index. Always present (unlike the
   * other optional sections above) — an empty `stale_layers` is itself
   * meaningful ("checked, found nothing stale" vs. "section absent").
   */
  doc_staleness: ContextDocStaleness;
  warnings: ContextWarning[];
}

export interface ContextLayerConstraints {
  scope: string;
  layer: string;
  optimizing_for: string[];
  anti_responsibilities: string[];
  boundaries: string[];
  invariants: string[];
}

export interface ContextWorkpadState {
  path: string;
  item: string | null;
  opened: string | null;
  last_updated: string | null;
  env: string | null;
  plan: { total: number; checked: number; unchecked_preview: string[] };
  acceptance_criteria: { total: number; checked: number };
  validation: { total: number; checked: number };
}

export type ContextWorkpadResult = ({ exists: true } & ContextWorkpadState) | { exists: false };

export interface ItemContextBundle {
  ok: true;
  intent: 'item';
  item_id: string;
  scope: string;
  item: ContextItemSummary;
  /** Layer constraints for the item's primary layer(s), bounded to LAYER_CONSTRAINTS_CAP. */
  layer_constraints: ContextLayerConstraints[];
  context: {
    layer_docs: string[];
    files_to_read: string[];
    read_plan: ContextReadPlanEntry[];
    verification_plan: ContextVerificationEntry[];
  };
  workpad: ContextWorkpadResult;
  warnings: ContextWarning[];
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
    ...(item.done_when ?? []).map(doneWhenText),
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

export function itemLayerIds(item: Item): string[] {
  // `affects` conventionally repeats the item's primary `layer` (and
  // sometimes overlaps `layers`) — dedup so an item boosts a given layer at
  // most once instead of double-counting it in `itemBoostForLayer`.
  const ids = [item.layer, ...(item.layers ?? []), ...(item.affects ?? [])].filter(
    (value): value is string => Boolean(value),
  );
  return [...new Set(ids)];
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

// ---------------------------------------------------------------------------
// Shared helpers for `session` and `item` intents.
// ---------------------------------------------------------------------------

const DATE_RE = /\d{4}-\d{2}-\d{2}/g;

/** Latest `YYYY-MM-DD` date found anywhere in `text`, or null if none. */
function mostRecentDateIn(text: string): Date | null {
  const matches = text.match(DATE_RE);
  if (!matches) return null;
  let latest: Date | null = null;
  for (const match of matches) {
    const candidate = new Date(`${match}T00:00:00.000Z`);
    if (Number.isNaN(candidate.getTime())) continue;
    if (!latest || candidate.getTime() > latest.getTime()) latest = candidate;
  }
  return latest;
}

function daysSince(date: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

/** Reads `stale_now_days` / `stale_next_days` from principles.md's fenced threshold block. Defaults fail open. */
function readThresholds(principlesMd: string): { staleNowDays: number; staleNextDays: number } {
  let staleNowDays = 7;
  let staleNextDays = 30;
  const block = principlesMd.match(/```yaml\s*([\s\S]*?)```/);
  if (block) {
    try {
      const data = (parseYamlText(block[1]) as Record<string, unknown>) ?? {};
      if (typeof data.stale_now_days === 'number') staleNowDays = data.stale_now_days;
      if (typeof data.stale_next_days === 'number') staleNextDays = data.stale_next_days;
    } catch {
      // Malformed threshold block — fail open with defaults.
    }
  }
  return { staleNowDays, staleNextDays };
}

interface WorkpadFrontmatter {
  item: string | null;
  opened: string | null;
  last_updated: string | null;
  env: string | null;
}

function parseWorkpadFrontmatter(text: string): WorkpadFrontmatter {
  const fm: WorkpadFrontmatter = { item: null, opened: null, last_updated: null, env: null };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return fm;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'item' || key === 'opened' || key === 'last_updated' || key === 'env') {
      fm[key] = value.trim();
    }
  }
  return fm;
}

/** Body of a `## <header>` markdown section, up to the next `## ` heading or EOF. */
function markdownSectionBody(md: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?:\\r?\\n##\\s|$)`, 'i');
  return md.match(re)?.[1] ?? '';
}

function markdownBullets(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
}

function parseBulletSection(md: string, header: string): string[] {
  return markdownBullets(markdownSectionBody(md, header));
}

/** Supports both the `## Optimizing for` bullet header and the older inline `Optimizing-for:` convention. */
function parseOptimizingFor(md: string): string[] {
  const bullets = parseBulletSection(md, 'Optimizing for');
  if (bullets.length > 0) return bullets;
  const inline = md.match(/Optimizing-for:\s*(.+)/i);
  return inline ? [inline[1].trim()] : [];
}

interface CheckboxCounts {
  total: number;
  checked: number;
  unchecked: string[];
}

function countCheckboxes(body: string): CheckboxCounts {
  let total = 0;
  let checked = 0;
  const unchecked: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!match) continue;
    total += 1;
    if (match[1].toLowerCase() === 'x') checked += 1;
    else unchecked.push(match[2].trim());
  }
  return { total, checked, unchecked };
}

/** Reads and parses a workpad file. Returns null if missing/unreadable (fail open — caller omits the section). */
function readWorkpadState(repoRoot: string, workpadRelPath: string): ContextWorkpadState | null {
  const abs = path.join(repoRoot, workpadRelPath);
  if (!existsSync(abs)) return null;
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const fm = parseWorkpadFrontmatter(text);
  const plan = countCheckboxes(markdownSectionBody(text, 'Plan'));
  const acceptance = countCheckboxes(markdownSectionBody(text, 'Acceptance Criteria'));
  const validation = countCheckboxes(markdownSectionBody(text, 'Validation'));
  return {
    path: workpadRelPath,
    item: fm.item,
    opened: fm.opened,
    last_updated: fm.last_updated,
    env: fm.env,
    plan: { total: plan.total, checked: plan.checked, unchecked_preview: plan.unchecked.slice(0, 5) },
    acceptance_criteria: { total: acceptance.total, checked: acceptance.checked },
    validation: { total: validation.total, checked: validation.checked },
  };
}

function workpadResult(repoRoot: string, workpadPath: string | undefined): ContextWorkpadResult {
  if (!workpadPath) return { exists: false };
  const state = readWorkpadState(repoRoot, workpadPath);
  if (!state) return { exists: false };
  return { exists: true, ...state };
}

/**
 * "Last activity" date for an item: the workpad's `last_updated` if a workpad
 * exists and parses, else the most recent dated bullet in `notes:`. Returns null
 * when neither yields a date — staleness is indeterminate, not "fresh", in that case.
 */
function activityDateForItem(repoRoot: string, item: Item): Date | null {
  if (item.workpad) {
    const workpad = readWorkpadState(repoRoot, item.workpad);
    if (workpad?.last_updated) {
      const parsed = new Date(`${workpad.last_updated}T00:00:00.000Z`);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return mostRecentDateIn(normalizeNotes(item.notes));
}

function splitLayerRef(defaultScopeId: string, ref: string): { scopeId: string; layerId: string } {
  if (ref.includes(':')) {
    const [scopeId, layerId] = ref.split(':', 2);
    return { scopeId, layerId };
  }
  return { scopeId: defaultScopeId, layerId: ref };
}

/** The item's own layer(s) — `layer` if set, else `layers`. Does NOT include `affects`. */
function primaryLayerRefs(defaultScopeId: string, item: Item): Array<{ scopeId: string; layerId: string }> {
  const raw = item.layer ? [item.layer] : (item.layers ?? []);
  return raw.map((ref) => splitLayerRef(defaultScopeId, ref));
}

function layerConstraintsFor(repoRoot: string, scopeId: string, layerId: string): ContextLayerConstraints | null {
  const content = readLayerContent(repoRoot, scopeId, layerId);
  if (!content.intentMd) return null;
  return {
    scope: scopeId,
    layer: layerId,
    optimizing_for: parseOptimizingFor(content.intentMd),
    anti_responsibilities: parseBulletSection(content.intentMd, 'Anti-responsibilities'),
    boundaries: parseBulletSection(content.intentMd, 'Boundaries'),
    invariants: parseBulletSection(content.intentMd, 'Invariants'),
  };
}

function allItemEntries(state: TenboState): Array<{ scope: string; item: Item }> {
  const out: Array<{ scope: string; item: Item }> = [];
  for (const scope of state.scopes) {
    for (const item of scope.items) out.push({ scope: scope.id, item });
  }
  for (const item of state.crossCuttingRoadmap ?? []) out.push({ scope: 'cross-cutting', item });
  return out;
}

const PENDING_RECONCILIATION_CAP = 12;
const PENDING_RECONCILIATION_REL_PATH = '.tenbo/.pending-reconciliation.yaml';

/**
 * `.tenbo/.pending-reconciliation.yaml` summary (td-036): total `count` (unbounded,
 * unchanged from the pre-td-036 shape) plus a bounded, deterministically-ordered
 * per-entry `{ layer, kind }` breakdown. Reuses `readPendingReconciliation`
 * (reconciliationFlag.ts) rather than re-parsing the YAML here — that helper is
 * already fail-open (missing/malformed file → `[]`, never throws), so this never
 * throws either. Sorted by layer, then kind, then opened_at for a stable order
 * before truncating to PENDING_RECONCILIATION_CAP.
 */
function pendingReconciliationSummary(repoRoot: string): ContextPendingReconciliation {
  const entries = readPendingReconciliation(repoRoot);
  const sorted = [...entries].sort((a, b) =>
    a.layer.localeCompare(b.layer) || a.kind.localeCompare(b.kind) || a.opened_at.localeCompare(b.opened_at));
  return {
    count: entries.length,
    path: PENDING_RECONCILIATION_REL_PATH,
    entries: sorted.slice(0, PENDING_RECONCILIATION_CAP).map((entry) => ({ layer: entry.layer, kind: entry.kind })),
  };
}

/**
 * Cheap validation delta: compares a fresh `validate(state)` run's issue counts against
 * the previous `.tenbo/.validation-status.json` snapshot's counts. This is a count delta,
 * not an identity-diff (see `validate-cli.ts`'s `computeDiff` for that) — cheap and
 * sufficient for a session briefing. Omitted when no prior snapshot exists.
 */
function validationDeltaSummary(repoRoot: string, state: TenboState): ContextValidationDelta | undefined {
  const abs = path.join(repoRoot, '.tenbo', '.validation-status.json');
  if (!existsSync(abs)) return undefined;
  let prev: { generated_at?: string; errors?: unknown[]; warnings?: unknown[] } | null = null;
  try {
    prev = JSON.parse(readFileSync(abs, 'utf8'));
  } catch {
    return undefined;
  }
  if (!prev) return undefined;
  const previousErrors = Array.isArray(prev.errors) ? prev.errors.length : 0;
  const previousWarnings = Array.isArray(prev.warnings) ? prev.warnings.length : 0;
  const result = validate(state);
  return {
    generated_at: prev.generated_at ?? '',
    previous_errors: previousErrors,
    previous_warnings: previousWarnings,
    current_errors: result.errors.length,
    current_warnings: result.warnings.length,
    new_errors: Math.max(0, result.errors.length - previousErrors),
    new_warnings: Math.max(0, result.warnings.length - previousWarnings),
  };
}

/** Most recent bullets from `.tenbo/observations.md`, preferring ones dated within `maxDays`. Omitted when absent. */
function recentObservationsList(repoRoot: string, now: Date, maxDays = 7): string[] | undefined {
  const abs = path.join(repoRoot, '.tenbo', 'observations.md');
  if (!existsSync(abs)) return undefined;
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('-'));
  const recent = bullets.filter((line) => {
    const date = mostRecentDateIn(line);
    return date ? daysSince(date, now) <= maxDays : true;
  });
  const pool = recent.length > 0 ? recent : bullets;
  return pool.slice(-OBSERVATIONS_CAP);
}

const DOC_STALENESS_CAP = 12;

/**
 * Doc-staleness signal (td-027): every layer's `code-map.md` generated region
 * checked against the current source index via `isLayerCodeMapStale` (td-026),
 * capped to DOC_STALENESS_CAP. Fail-open — reuses `checkSourceIndexFreshness`'s
 * existing 'fresh' gate (same pattern `resolveFeatureContext` uses for
 * `sourceQuery`): when the index is missing/stale/corrupt/incompatible, this
 * returns an empty result rather than computing anything, and the caller's
 * existing `sourceIndexWarning` already explains why in `warnings` — no
 * separate warning needed here. A single layer's check throwing is swallowed
 * per-layer so one bad layer doesn't blank out the rest.
 */
function docStalenessSummary(
  repoRoot: string,
  state: TenboState,
  sourceFreshness: ReturnType<typeof checkSourceIndexFreshness>,
  index: SourceIndex | null,
): ContextDocStaleness {
  if (sourceFreshness.status !== 'fresh' || !index) {
    return { stale_layers: [], checked_layers: 0 };
  }
  const staleLayers: ContextDocStaleLayerRef[] = [];
  let checked = 0;
  for (const scope of state.scopes) {
    for (const layer of scope.layers) {
      checked += 1;
      let result: ReturnType<typeof isLayerCodeMapStale>;
      try {
        result = isLayerCodeMapStale(repoRoot, index, scope, layer);
      } catch {
        continue; // Fail open — one layer's check erroring never blanks the rest.
      }
      if (result.stale) {
        staleLayers.push({ scope: scope.id, layer: layer.id, reason: result.reason ?? 'code-map region stale' });
      }
    }
  }
  return { stale_layers: staleLayers.slice(0, DOC_STALENESS_CAP), checked_layers: checked };
}

/**
 * `session` intent — deterministic session-gate briefing bundle. Fail-open: every
 * section beyond `now`/`stale`/`warnings` is optional and omitted (not errored)
 * when its source file is absent. All lists bounded to SESSION_LIST_CAP (12,
 * matching `read_plan`'s cap) except `recent_observations` (OBSERVATIONS_CAP, 5)
 * and `doc_staleness.stale_layers` (DOC_STALENESS_CAP, 12).
 */
export function resolveSessionContext(repoRoot: string, opts: ResolveOptions = {}): SessionContextBundle {
  const now = opts.now ?? new Date();
  const state = readState(repoRoot);
  const { staleNowDays, staleNextDays } = readThresholds(state.workspaceContent.principlesMd);
  const entries = allItemEntries(state);

  const nowEntries = entries
    .filter((entry) => entry.item.status === 'now')
    .map((entry) => ({ ...entry, activity: activityDateForItem(repoRoot, entry.item) }))
    .sort((a, b) => comparePriority(a.item, b.item) || a.item.id.localeCompare(b.item.id));

  const nextEntries = entries
    .filter((entry) => entry.item.status === 'next')
    .map((entry) => ({ ...entry, activity: activityDateForItem(repoRoot, entry.item) }));

  const nowItems: ContextSessionItemRef[] = nowEntries.slice(0, SESSION_LIST_CAP).map((entry) => ({
    id: entry.item.id,
    scope: entry.scope,
    title: entry.item.title,
    days_active: entry.activity ? daysSince(entry.activity, now) : null,
  }));

  // `staleNow` deliberately keeps `nowEntries`'s existing priority order (no extra
  // sort by staleness) — for `now` items, priority order is the meaningful surfacing
  // order for a session briefing. `staleNext` below sorts by staleness-descending
  // first since `next` items have no comparable in-flight priority signal yet.
  const staleNow: ContextStaleItemRef[] = nowEntries
    .filter((entry): entry is typeof entry & { activity: Date } => entry.activity !== null && daysSince(entry.activity, now) > staleNowDays)
    .slice(0, SESSION_LIST_CAP)
    .map((entry) => ({
      id: entry.item.id,
      scope: entry.scope,
      title: entry.item.title,
      days_active: daysSince(entry.activity, now),
      threshold_days: staleNowDays,
    }));

  const staleNext: ContextStaleItemRef[] = nextEntries
    .filter((entry): entry is typeof entry & { activity: Date } => entry.activity !== null && daysSince(entry.activity, now) > staleNextDays)
    .sort((a, b) => daysSince(b.activity, now) - daysSince(a.activity, now))
    .slice(0, SESSION_LIST_CAP)
    .map((entry) => ({
      id: entry.item.id,
      scope: entry.scope,
      title: entry.item.title,
      days_active: daysSince(entry.activity, now),
      threshold_days: staleNextDays,
    }));

  const pendingReconciliation = pendingReconciliationSummary(repoRoot);
  const validationDelta = validationDeltaSummary(repoRoot, state);
  const observations = recentObservationsList(repoRoot, now);

  const workpadResume: ContextWorkpadResumeCandidate[] = entries
    .filter((entry) => entry.item.workpad)
    .map((entry) => ({ entry, workpad: readWorkpadState(repoRoot, entry.item.workpad as string) }))
    .filter((row): row is { entry: typeof entries[number]; workpad: ContextWorkpadState } =>
      row.workpad !== null && row.workpad.plan.total > 0 && row.workpad.plan.checked < row.workpad.plan.total)
    .slice(0, SESSION_LIST_CAP)
    .map(({ entry, workpad }) => ({
      item_id: entry.item.id,
      scope: entry.scope,
      title: entry.item.title,
      workpad: workpad.path,
      unchecked_plan_items: workpad.plan.total - workpad.plan.checked,
    }));

  const sourceIndex = readSourceIndex(repoRoot);
  const sourceFreshness = checkSourceIndexFreshness(repoRoot, sourceIndex);
  const sourceWarning = sourceIndexWarning(sourceFreshness);
  const docStaleness = docStalenessSummary(repoRoot, state, sourceFreshness, sourceIndex);

  return {
    ok: true,
    intent: 'session',
    now: { count: nowEntries.length, items: nowItems },
    stale: { now: staleNow, next: staleNext },
    pending_reconciliation: pendingReconciliation,
    ...(validationDelta ? { validation_delta: validationDelta } : {}),
    ...(workpadResume.length > 0 ? { workpad_resume: workpadResume } : {}),
    ...(observations && observations.length > 0 ? { recent_observations: observations } : {}),
    doc_staleness: docStaleness,
    warnings: [
      ...agentContextWarnings(repoRoot, now),
      ...(sourceWarning ? [sourceWarning] : []),
    ],
  };
}

/**
 * `item` intent — deterministic per-item bundle: core fields, layer constraints for
 * the item's own layer(s), a bounded read plan (reusing the feature path's
 * `buildReadPlan`), and workpad state if one exists. Throws `RoadmapStoreError`
 * (`not_found`) via `findItem` when the id doesn't resolve — surfaced by the CLI's
 * existing error handling, same as other `item` subcommands.
 */
export function resolveItemContext(repoRoot: string, itemId: string, opts: ResolveOptions = {}): ItemContextBundle {
  const now = opts.now ?? new Date();
  const located = findItem(repoRoot, itemId);
  const item = located.item;

  const layerRefs = primaryLayerRefs(located.scopeId, item).slice(0, LAYER_CONSTRAINTS_CAP);
  const layerDocs = layerRefs.flatMap(({ scopeId, layerId }) => [
    repoRelative('.tenbo', 'scopes', scopeId, 'layers', layerId, 'intent.md'),
    repoRelative('.tenbo', 'scopes', scopeId, 'layers', layerId, 'code-map.md'),
  ]);
  const layerConstraints = layerRefs
    .map(({ scopeId, layerId }) => layerConstraintsFor(repoRoot, scopeId, layerId))
    .filter((entry): entry is ContextLayerConstraints => entry !== null);

  const filesToRead = item.files_to_read ?? [];
  const readPlan = buildReadPlan({
    layerDocs,
    activeItems: [{ scope: located.scopeId, item, score: 0 }],
    matchingItems: [],
    sourceEvidence: [],
    filesToRead,
  });

  const sourceFreshness = checkSourceIndexFreshness(repoRoot, readSourceIndex(repoRoot));
  const sourceWarning = sourceIndexWarning(sourceFreshness);

  return {
    ok: true,
    intent: 'item',
    item_id: item.id,
    scope: located.scopeId,
    item: summarizeItem(item, 'execution'),
    layer_constraints: layerConstraints,
    context: {
      layer_docs: layerDocs,
      files_to_read: filesToRead,
      read_plan: readPlan,
      verification_plan: buildVerificationPlan(),
    },
    workpad: workpadResult(repoRoot, item.workpad),
    warnings: [
      ...agentContextWarnings(repoRoot, now),
      ...(sourceWarning ? [sourceWarning] : []),
    ],
  };
}
