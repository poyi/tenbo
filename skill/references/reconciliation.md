# Per-task reconciliation (Behavior 8 detail)

Reference doc for the per-task reconciliation behavior summarized in SKILL.md. The procedure runs at the end of every coding task the agent completes.

**Note on artifact dependencies.** This behavior reads and writes several v2 artifacts that may not yet exist in a given repo: per-layer `intent.md` and `code-map.md`, per-scope `metrics.json`, workspace `principles.md` and `observations.md`. If a referenced artifact is missing, the agent skips that part of the procedure silently — the behavior is degrade-gracefully, not error-out. Templates for these artifacts live under `<this-skill>/templates/` and are created from templates during initialization.

## Trigger

End of every coding task. Runs whether or not the task maps to a roadmap item. If no `.tenbo/` exists, skip silently.

## Procedure

1. **Read the diff.** Use the task's git diff (or working-tree diff if uncommitted) — already in conversation context, no extra read.
2. **Map changed files → affected layers** via the `files` globs in each scope's `architecture.yaml`.
3. **No layers affected → silent.** No further work, no output.
4. **For each affected layer**, run these checks (cheap, pattern-matching only):
   - **Mechanical updates** (apply silently):
     - New file present in glob match but not listed in `code-map.md` → add row.
     - File renamed or deleted → update row or remove.
     - **AST-based code-map update:** For each changed file, run the matching
       language pattern from `references/ast-patterns.md` to extract top-level
       exports. Compare against `code-map.md` current listings. Add/remove/rename
       entries mechanically — zero LLM tokens. Only flag for agent review when a
       new entry point appears or an export is removed that other layers depend on.
     - New external import (package not in `dependencies.external`) → add to architecture.yaml.
     - New outbound layer dependency observed (cross-layer import) → add to architecture.yaml.
     - Recompute `metrics.json` for the affected layer.
     - **Auto-assign globs:** If a changed file is in an uncovered directory (not
       matched by any layer's `files` globs), propose a glob assignment to the
       most likely layer: "You created `src/combat/`. Want me to assign it to
       the Combat layer?" Apply on confirmation; defer on decline.
   - **Intent candidate drift** (flag for the universal prompting rule):
     - Diff in a file listed under `code-map.md` "Entry points" exceeds 50 changed lines.
     - A file in this layer adds a new exported symbol (top-level `export` in TS/JS, or equivalent in other languages) — the symbol becomes part of the layer's public surface.
     - The task's diff touches files mapped to two or more layers AND the change moves logic between them (added imports across the layer boundary).
     - Thresholds (e.g., the 50-line cutoff) live in `principles.md` as `intent_drift_entrypoint_lines: 50` and may be tuned per repo.
   - **Boundary decision candidate** (propose a dated entry):
     - The task itself was a structural change — split a file, moved logic across layers, introduced a new sub-concern.
   - **Roadmap drift:**
     - Task closed an item (existing DoD already handles this — Behavior 5).
     - Task touched files that map to a `now` roadmap item that wasn't assigned to the agent → flag.
   - **Threshold violations:**
     - Read `metrics.json` against thresholds in `principles.md`. Flag any newly-crossed thresholds.

5. **All mechanical?** Apply silently. Report a single one-liner:
   > Tenbo: updated AI Assistant code-map (2 new files); metrics ok.

6. **Anything needing the prompting rule?** Present a compact summary and ask:
   > Tenbo reconciliation: 2 mechanical (applied), 1 needing input — review now or defer?

7. **User defers?** Append the unresolved items to `.tenbo/.pending-reconciliation.yaml` so the next task's reconciliation surfaces them again.

Mechanical items from step 5 are NEVER persisted in `.pending-reconciliation.yaml` — they apply silently and disappear from the ledger. Only items in the four "judgment" buckets (intent_drift, boundary_decision, roadmap_drift, threshold) can be deferred.

8. **Observations emitted?** Append to `.tenbo/observations.md` (running log, agent-appended). One bullet per observation, dated. The tenbo viewer will render this file once viewer support lands (Plan B).

9. **Update file-hash cache.** Recompute SHA256 hashes for all files matched by
   affected layers' globs. Write to `.tenbo/.file-hashes.json`. Format:
   ```json
   { "src/canvas/Canvas.tsx": "a1b2c3...", "src/inspector/Panel.tsx": "d4e5f6..." }
   ```
   This cache enables fast drift detection at session start (compare hashes vs
   current files without reading content). Cost: I/O-bound, not token-bound.

10. **Regenerate agent-context.md.** Render `.tenbo/agent-context.md` from
    `templates/agent-context.md.tmpl` using current workspace, roadmap, and
    validation state. This is the Tier 0 briefing document that replaces reading
    multiple YAML files at session start. Always regenerate — it's cheap and
    ensures the briefing is never stale.

11. **Maturity bump check.** Read `maturity` from `workspace.yaml`. Check if the
    project has crossed a threshold:
    - `new` → `early`: source files now exist (source_file_count ≥ 5).
    - `early` → `active`: at least one layer has a populated `intent.md`.
    - `active` → `mature`: all layers have populated docs AND >50% of roadmap
      items have been through a completion cycle (`status: done`).
    If a bump is warranted, update `workspace.yaml` silently. Do not bump
    backwards — maturity is monotonically increasing.

## Token discipline

- Step 1 is free — diff already in context.
- Steps 2–3 are pure pattern matching — no extra LLM-heavy reading.
- Step 4 only deep-reads files in layers that actually changed.
- Most tasks → silent or one-liner. Only structural tasks → real interaction.

## Pending-reconciliation file format

`.tenbo/.pending-reconciliation.yaml`:

```yaml
items:
  - opened_at: 2026-04-26
    layer: ai-assistant
    kind: intent_drift   # one of: intent_drift, boundary_decision, roadmap_drift, threshold
    description: <short, plain-English what needs review>
    # source_commit: HEAD at time of observation. Informational only — stale SHAs after rebase/squash are not an error.
    source_commit: <SHA or "uncommitted">
```

When the user resolves an item, the agent removes it from the file. When the file empties, delete it.

Validation warns when this file has ≥ 3 items unresolved beyond N tasks (default N = 3) — see `validation-rules.md`.
