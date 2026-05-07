export type Severity = 'critical' | 'warning' | 'info';

export type Confidence = 'high' | 'medium' | 'low';

export type Signal =
  | 'hotspot-files'
  | 'dead-code'
  | 'coupling'
  | 'doc-drift'
  | 'test-coverage'
  | 'aging-todos'
  | 'aging-superseded'
  | 'architecture-compliance'
  | 'redundancy';

export type ActionKind =
  | 'delete-file'
  | 'unexport'
  | 'split-file'
  | 'extract-shared'
  | 'move-file'
  | 'update-doc'
  | 'add-test'
  | 'resolve-todo'
  | 'triage-item';

export interface Suggestion {
  summary: string;       // imperative one-liner
  rationale: string;     // why
  action_kind: ActionKind;
}

// Signal-specific details payloads (discriminated union)
export type FindingDetails =
  | { kind: 'hotspot-files'; loc: number; top_functions: { name: string; loc: number }[]; commits_30d: number; split_candidates: string[] }
  | { kind: 'dead-code'; exports: string[]; last_imported_commit: string | null; git_age_days: number }
  | { kind: 'coupling'; source_file: string; target_file: string; import_lines: number[]; crosses_public_api: boolean }
  | { kind: 'doc-drift'; drift_type: 'missing-ref' | 'unreferenced-file' | 'stale-section'; doc_path: string; doc_mtime_iso: string | null; code_mtime_iso: string | null; affected_files: string[] }
  | { kind: 'test-coverage'; suggested_test_path: string }
  | { kind: 'aging-todos'; line: number; age_days: number; commit_hash: string; author: string; text: string; context: string }
  | { kind: 'aging-superseded'; item_id: string; item_title: string; age_days: number; referenced_items: { id: string; status: string }[] }
  | { kind: 'architecture-compliance'; expected_path_pattern: string; actual_path: string; rule: string }
  | { kind: 'redundancy'; copies: { path: string; lines: [number, number] }[]; similarity_pct: number };

export interface Finding {
  id: string;             // "<layer>.<signal>.<short-target>"
  signal: Signal;
  severity: Severity;
  confidence: Confidence;
  layer: string;
  target: string;         // primary file path (repo-relative)
  headline: string;
  suggestion: Suggestion;
  details: FindingDetails;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

export const SIGNAL_WEIGHTS_DEFAULT: Signal[] = [
  'dead-code',
  'hotspot-files',
  'coupling',
  'architecture-compliance',
  'redundancy',
  'doc-drift',
  'test-coverage',
  'aging-todos',
  'aging-superseded',
];

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

// Compile-time guarantee that FindingDetails has exactly one variant per Signal.
// If Signal gains a value or FindingDetails loses one (or vice versa),
// these aliases will fail to type-check and the build breaks.
type _SignalsCoverDetails = Exclude<Signal, FindingDetails['kind']> extends never ? true : never;
type _DetailsCoverSignals = Exclude<FindingDetails['kind'], Signal> extends never ? true : never;
const _signalCoverage: _SignalsCoverDetails = true;
const _detailsCoverage: _DetailsCoverSignals = true;
void _signalCoverage;
void _detailsCoverage;
