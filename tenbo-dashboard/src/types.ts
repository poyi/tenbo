import type { Finding } from './api/lib/health/types';

// Naming convention:
// - snake_case fields mirror on-disk JSON/YAML keys (e.g., `description` from architecture.yaml,
//   `file_count` from metrics.json). Do not rename these — they round-trip with the file format.
// - camelCase fields are in-memory composed state assembled by the viewer (e.g., `crossCuttingRoadmap`,
//   `layerDocs`). Renaming these is purely an internal refactor.

export type Status = 'now' | 'next' | 'later' | 'done' | 'dropped';

/**
 * Advisory priority marker. Does NOT affect roadmap ordering — items still execute
 * in `status` bucket + file order (see Behavior 6). Priority is purely a flag agents
 * and humans can use to highlight critical items in the viewer or in queries.
 * Optional: most items leave it unset.
 */
export type Priority = 'p0' | 'p1' | 'p2' | 'p3';

/**
 * Optional per-phase progress entry for multi-phase roadmap items.
 *
 * Phases are ordered by their position in the YAML list. The numeric `id` is for
 * stable references (`<item-id>.p<id>`); the validator checks ids are 1..N positional.
 *
 * When `phases:` is present on an item, the item's top-level `status` is derived
 * (`done` if every phase is done; `now` if any phase is `now`; otherwise `next`
 * if any phase is `next`; otherwise `later`). See `derivePhaseStatus` in
 * `phases.ts`.
 */
export interface Phase {
  id: number;
  title: string;
  status: Status;
  /** YYYY-MM-DD; set when status becomes `done`. */
  completed_at?: string;
  notes?: string;
}

export interface Item {
  id: string;                  // rm-NNN
  title: string;
  layer?: string;              // single-layer items
  layers?: string[];           // cross-scope items
  status: Status;
  description: string;
  links?: string[];
  notes?: string;
  /** layer ids touched by this item (bare ids for same-scope items, "<scope>:<layer>" for cross-scope items) */
  affects?: string[];
  /** 1–3 plain-language bullets defining "done" */
  done_when?: string[];
  /** repo-relative file paths that future implementers should read first */
  files_to_read?: string[];
  /** freeform bullets noting known unknowns or risks */
  risks?: string[];
  type?: 'feature' | 'bug' | 'refactor' | 'spike';
  priority?: Priority;
  /**
   * Goals this item advances. Either a list of goal IDs (e.g. ["g1", "g3"])
   * matching IDs declared in `overview.md` Product goals section, or the
   * literal string "exploratory" for items captured without a clear goal
   * connection. Items lacking goal_ref entirely produce a validator warning
   * (not an error) — they're surfaced for backfill but don't block anything.
   * See sk-022 for context.
   */
  goal_ref?: string[] | 'exploratory';
  /** Optional multi-phase progress. When present, item-level `status` is derived. */
  phases?: Phase[];
  /**
   * At-most-one parent: the id of the roadmap item that surfaced/dispatched this one.
   * Format matches the standard item id pattern (`<prefix>-NNN` or `x-NNN`).
   * Convention (Behavior 5 DoD): when a subagent's report surfaces a follow-up item,
   * the new item should set `spawned_from` to the dispatching item's id.
   */
  spawned_from?: string;
  /**
   * The id of the item that replaced/superseded this one. When set, the item's
   * status should be `dropped`. The validator enforces this constraint and checks
   * for cycles and dangling references.
   */
  superseded_by?: string;
  /**
   * Peer relationships. Any number of ids in the same format. Order is not significant.
   * Not parent–child — for that use `spawned_from`.
   */
  related?: string[];
  /**
   * Stamped during Behavior 5 DoD when this item flips to `done`.
   * Either an ISO date (`YYYY-MM-DD`) confirming the layer's intent.md/code-map.md
   * was updated as part of completing this item, OR `skipped — <reason>` for
   * internal-only changes with no architecture surface impact. The validator
   * (x-003 phase 3) warns when an item with status:done and type ∈ {feature,
   * refactor, bug} lacks this field.
   */
  doc_update?: string;
  /**
   * Pre-flight violations recorded at capture time when the user accepted an
   * item despite a flagged violation. Each entry: which check fired, what the
   * outcome was, what the user decided, and their rationale. Empty / undefined
   * when item passed pre-flight cleanly. See sk-029.
   */
  preflight_violations?: Array<{
    check: string;            // e.g. "ui-components anti-responsibility: no direct fs writes"
    outcome: 'violation' | 'threshold-cross' | 'dependency-direction';
    decision: 'accept-with-violation' | 'scope-adjusted' | 'deferred';
    rationale?: string;
  }>;
}

export interface Layer {
  id: string;
  name: string;
  description: string;
  files: string[];
  dependencies?: {
    /** layer ids in same scope that import from this layer */
    inbound?: string[];
    /** layer ids in same scope that this layer imports from */
    outbound?: string[];
    /** package names or external service identifiers (e.g., "anthropic-sdk", "supabase-js"); not layer ids */
    external?: string[];
  };
  parent?: string;
}

export interface Scope {
  id: string;
  path: string;
  description: string;
  layers: Layer[];
  items: Item[];
  archivedItems?: Item[];
}

export interface CrossCutting {
  id: string;
  description: string;
  spans: string[];
}

export interface LayerMetrics {
  file_count: number;
  total_lines: number;
  outbound_deps: number;
  deep_dive_count: number;
  intent_age_days: number | null;
  pct_roadmap_in_now: number;
}

export interface ScopeMetrics {
  /** ISO 8601 UTC timestamp */
  generated_at: string;
  layers: Record<string, LayerMetrics>;
  /** Findings produced by health analyzers. Empty array until Phase 1 is wired. */
  findings: Finding[];
}

export type MetricsRefreshState = 'fresh' | 'stale' | 'refreshing' | 'failed';

export interface MetricsRefreshStatus {
  status: MetricsRefreshState;
  generatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  warning?: string;
  error?: string;
}

/** In-memory file-presence flags; composed by tenboFs from filesystem checks. Not on disk. */
export interface LayerDocs {
  hasIntent: boolean;
  hasCodeMap: boolean;
  /** epoch milliseconds (matches fs.statSync().mtimeMs and Date.now()); null if intent.md absent */
  intentMtime: number | null;
  /** epoch milliseconds; null if code-map.md absent */
  codeMapMtime: number | null;
  /** true if intent.md exists but contains no non-comment, non-heading content */
  intentEmpty: boolean;
}

export interface TenboState {
  scopes: Scope[];
  crossCutting: CrossCutting[];
  narratives: Record<string, string>; // key: "<scope>/<layer>", value: markdown
  workspaceContent: WorkspaceContent;
  crossCuttingRoadmap?: Item[];
  layerDocs?: Record<string, LayerDocs>;
  metrics?: Record<string, ScopeMetrics>;
  metricsStatus?: Record<string, MetricsRefreshStatus>;
  /**
   * Set of repo-relative paths of every file present under `.tenbo/specs/`
   * (including `.tenbo/specs/archive/`). Populated by tenboFs.readState; used
   * by the validator to check that `links:` entries pointing into specs
   * resolve to a real file. Absent when `.tenbo/specs/` does not exist.
   */
  specFiles?: Set<string>;
  /**
   * Decision records loaded from `.tenbo/decisions/`. Absent if the directory
   * does not exist. Keyed by slug for `superseded_by` resolution.
   */
  decisions?: Record<string, DecisionRecord>;
}

export type ValidateLevel = 'error' | 'warning';

export interface ValidateIssue {
  level: ValidateLevel;
  message: string;          // plain language
  scope?: string;
  layerId?: string;
  itemId?: string;
}

export interface ValidateResult {
  errors: ValidateIssue[];
  warnings: ValidateIssue[];
}

export interface RelatedDoc {
  path: string;              // relative to repo root
  itemId: string;            // tenbo_item value from frontmatter
  title?: string;            // first heading or filename
}

export interface LayerDoc {
  filename: string;
  title: string | null;
}

export interface WorkspaceContent {
  overviewMd: string;
  principlesMd: string;
  glossaryMd: string;
  observationsMd: string;
  overviewMtime: number | null;
  principlesMtime: number | null;
  glossaryMtime: number | null;
  observationsMtime: number | null;
}

/**
 * Project-level decision record loaded from `.tenbo/decisions/<slug>.md`.
 * Only created when a future audit would re-suggest the same thing without
 * the rationale. See `skill/templates/decision.md.tmpl` for the shape.
 */
export interface DecisionRecord {
  /** repo-relative path, e.g. `.tenbo/decisions/foo.md` */
  path: string;
  /** filename slug without extension */
  slug: string;
  /** parsed frontmatter — values may be missing on malformed files */
  frontmatter: {
    id?: string;
    date?: string;
    status?: 'accepted' | 'superseded' | string;
    title?: string;
    related_items?: string[];
    superseded_by?: string;
    [k: string]: unknown;
  };
  /** body content after frontmatter (markdown) */
  body: string;
}

export interface LayerContent {
  scope: string;
  layer: string;
  readme: string;
  intentMd: string;
  codeMapMd: string;
}
