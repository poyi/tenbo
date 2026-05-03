# Health metrics

Tenbo tracks a small set of cheap, deterministic per-layer metrics so the agent can surface refactor candidates without re-reading the codebase. The metric computation function ships in the dashboard back-end (`tenbo-dashboard/src/api/lib/metrics.ts`, exported as `computeScopeMetrics`); if tenbo-dashboard is installed, `npx tenbo-dashboard metrics --all` persists `.tenbo/scopes/<scope>/metrics.json`. If the dashboard is not installed, `metrics.json` will typically be absent — every threshold check defensively skips, so this doc still describes the agent-facing contract even though the file isn't being produced yet. Thresholds for "too big / too stale / too connected" live in `principles.md` (user-editable), not here — this doc only defines what the metrics ARE and how the agent reacts when one crosses a threshold.

If `metrics.json` is absent (older checkout, viewer v2 tooling not yet installed in this repo), treat all metrics as unknown and skip threshold checks. Do not attempt to recompute metrics from scratch inside the skill.

## Per-layer metric definitions

Each metric is computed once per scope, once per refresh, for every layer in that scope's `architecture.yaml`.

- `file_count` — number of files matched by the layer's `files` globs in `architecture.yaml`. Computation: glob match count.
- `total_lines` — total lines of code across matched files. Computation: sum of `wc -l` (read each matched file in TS, count newlines) over the matched set.
- `outbound_deps` — number of layers this layer depends on. Computation: length of `dependencies.outbound` in `architecture.yaml`.
- `deep_dive_count` — sibling deep-dive `.md` files in the layer directory. Computation: count of `.md` files in the layer directory minus the required/optional set (`README.md`, `intent.md`, `code-map.md`, `decisions.md`, `open-questions.md`, `migrations.md`). Files matching the `<feature>-deep-dive.md` pattern ARE intentionally counted — that's the metric's purpose.
- `intent_age_days` — days since the layer's `intent.md` was last modified. Computation: `(Date.now() - statSync(intent.md).mtimeMs) / 86_400_000`, rounded down.
- `pct_roadmap_in_now` — share of this layer's roadmap items currently `status: now`. Computation: `100 * count(items where layer == L && status == 'now') / count(items where layer == L)` (report 0 when the layer has no roadmap items, avoiding divide-by-zero). Items in the workspace `.tenbo/roadmap.yaml` with `affects:` referencing this layer count toward the denominator and numerator.

## `metrics.json` shape

Persisted at `.tenbo/scopes/<scope>/metrics.json`. One file per scope:

```json
{
  "generated_at": "2026-04-26T14:23:00Z",
  "layers": {
    "ai-assistant": {
      "file_count": 34,
      "total_lines": 4200,
      "outbound_deps": 3,
      "deep_dive_count": 2,
      "intent_age_days": 4,
      "pct_roadmap_in_now": 12,
      "threshold_violations": []
    }
  }
}
```

`threshold_violations` is an array of metric names (strings) that crossed the corresponding threshold in `principles.md` at `generated_at` time. Empty array = healthy.

## Thresholds

Threshold values are defined in `principles.md` under the "Metric thresholds" heading as a flat YAML block. Defaults shipped in `principles.md.tmpl`:

- `max_files_per_layer: 50`
- `max_outbound_deps_per_layer: 5`
- `max_lines_per_layer_total: 8000`
- `max_days_intent_stale: 30`
- `max_pct_roadmap_in_now: 20`

This file does NOT redefine thresholds. `principles.md` is canonical. If a user edits a threshold there, the next metrics run picks up the new value automatically.

## Decision tree on a threshold crossing

When the metrics tool reports a `threshold_violations` entry for a layer, the agent decides what to do based on the kind of violation:

- **Mechanical, narrow, no judgment needed** (e.g., `deep_dive_count` exceeded because a new sibling file was added) → apply mechanically with no further user prompt. Example mechanical action: split a long deep-dive into two and update the `code-map.md` link.
- **Worth surfacing but not blocking** (e.g., `intent_age_days` over threshold; `total_lines` slightly over) → append a one-line dated bullet to `.tenbo/observations.md` so the user sees it on the next refresh sweep. Do not prompt mid-task.
- **Plausibly a real refactor** (e.g., `file_count` and `outbound_deps` both over threshold; `pct_roadmap_in_now` over threshold suggesting too many parallel commitments) → propose a roadmap item with `type: refactor` and `status: later`, classified to the layer. Use the universal prompting rule to confirm before writing.

When in doubt between bucket 2 (observe) and bucket 3 (propose refactor), prefer bucket 2 — observations are cheap to revisit on the next refresh.

## Defensive behavior

- If the metrics tool has never run for a scope, `metrics.json` will not exist. Skip threshold checks for that scope and continue.
- If `generated_at` is more than 7 days old, treat the data as stale and offer to recompute (but do not block on it).
- Never write to `metrics.json` from this skill directly — it is machine-generated. Edits go through the metrics tool.
