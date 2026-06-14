# Tenbo Validation Rules

These rules are checked after any write to `.tenbo/`. The skill MUST run them and report any violations to the user before considering an operation complete.

## Schema rules

1. **`workspace.yaml` exists** at `.tenbo/workspace.yaml`.
2. **At least one scope** is defined in `workspace.yaml`.
3. **Every scope** has a non-empty `id`, `path`, and `description`.
4. **Scope `path`** points to a directory that exists in the repo.
5. **For every scope**, a directory exists at `.tenbo/scopes/<scope-id>/` containing `architecture.yaml` and `roadmap.yaml`.
6. **Every layer** has a non-empty `id`, `name`, `description`, and `files` list.
7. **Layer `parent`** (if set) references an existing layer in the same scope.
8. **Layer nesting depth** is ≤ 2 (a layer with a parent must not itself be a parent).
9. **Layer `id`** is unique within its scope.
10. **Every layer** has a `README.md` file at `.tenbo/scopes/<scope-id>/layers/<layer-id>/README.md`. (The layer is a directory; `README.md` is the plain-English narrative.)
11. **Every roadmap item** has a non-empty `id`, `title`, `layer` (or `layers`), `status`, and `description`.
12. **Roadmap item `id`** matches the pattern `rm-NNN` and is unique within its scope.
13. **Roadmap item `status`** is one of: `now`, `next`, `later`, `done`, `rework`.
14. **Roadmap item `layer`** (or each entry in `layers`) references an existing layer.
15. **Cross-cutting items** (`cross_cutting` in workspace.yaml) reference scopes that exist.

## File-glob health rules (warnings, not errors)

16. **Layer `files`** globs SHOULD match at least one real file. If none, warn: "layer `<id>` is orphaned (no files match)." Do not auto-delete.
17. **Top-level source files not covered by any layer** SHOULD be flagged for review (gives the user a chance to expand a layer or add a new one).

## Plain-English rules (warnings)

18. **`description` length** SHOULD be 5–30 words. Below: probably too terse. Above: probably too detailed for a phone-screen read.
19. **`description`** SHOULD avoid programming jargon (e.g., "module", "API", "endpoint", "interface", "abstraction"). The skill may suggest rewrites.

## v2 errors

These errors apply when v2 files are present in `.tenbo/`. Each rule is self-defensive: if the referenced file is absent (e.g., the v2 migration has not run yet), skip the check rather than fail.

24. **`intent.md` exists but is empty.** A layer's `intent.md` file is present but has no body after HTML comments and `^#.*$` heading lines are stripped (trimmed result has zero length). Skip when the file is absent. Note: a freshly-migrated skeleton with a single boundary-decision bullet (e.g., `- 2026-04-26: created — initial intent draft.`) is treated as non-empty by design — Phase 2 (skeleton creation) intentionally seeds enough content to satisfy this rule so users aren't blocked immediately after migration. The rule fires once a user deletes the skeleton without filling real content in.
25. **`architecture.yaml` references a layer with no `intent.md`.** For every `layer.id` in every scope's `architecture.yaml`, an `intent.md` file MUST exist at `.tenbo/scopes/<scope-id>/layers/<layer-id>/intent.md`. Skip per scope when that scope's `layers/` directory contains zero `intent.md` files (treat that scope as not-yet-migrated). Enforce within any scope that has at least one `intent.md`.
27. **`dependencies:` edge points to a non-existent layer.** Each entry in a layer's `dependencies.inbound` and `dependencies.outbound` arrays MUST reference an existing `layer.id` in the same scope. Cross-scope `external` edges are out of scope for this rule. Skip when the layer has no `dependencies:` block.
28. **Cross-cutting roadmap item references a non-existent scope or layer.** Applies to every `roadmap.yaml` in the workspace (workspace-level `.tenbo/roadmap.yaml` and scope-level `.tenbo/scopes/<scope>/roadmap.yaml`). For each item with `affects:`, validate every entry: workspace-level entries use `<scope-id>:<layer-id>` and must resolve to an existing scope and layer; scope-level entries use bare `<layer-id>` and must resolve to a layer in the containing scope. Skip a given roadmap file when it is absent.

## v2 warnings

29. **Layer has no `code-map.md`.** A layer directory exists and has an `intent.md`, but no `code-map.md`. Warn only — `populate-architecture` creates it lazily. Skip when the layer itself has no `intent.md` (caught by rule 25).
30. **Glossary term appears in 3+ docs but missing from `glossary.md`.** A term appears verbatim in `intent.md` files of 3+ layers across any scope, AND is not already an entry in `.tenbo/glossary.md`. A "term" is a single capitalized noun or multi-word capitalized phrase (e.g., "Token", "Approval Gate", "Visual Editor") extracted from `intent.md` body text — not headings, not code spans, not URLs. The threshold of 3 is overridable via `principles.md` key `glossary_term_min_occurrences` (default 3). Skip when `.tenbo/glossary.md` is absent.
31. **Roadmap item with `status: now` missing `done_when`.** A roadmap item whose `status` is `now` MUST have a non-empty `done_when` array. This rule applies only to `status: now`; other statuses are not checked.
32. **`.pending-reconciliation.yaml` has unresolved items beyond N tasks.** N defaults to 3 and is overridable via `principles.md` thresholds key `pending_reconciliation_max_tasks`. The count is the number of distinct `task_id` entries in `.tenbo/.pending-reconciliation.yaml`. If `task_id` entries are absent, count top-level list items in `.pending-reconciliation.yaml` instead. Skip when the file is absent.
33. **Metric threshold violation present in `metrics.json`.** Surface every entry in `threshold_violations` from any layer's `metrics.json` as a warning. This rule never blocks completion — it surfaces an existing computed violation, not a new one. Skip when `metrics.json` is absent.
34. **Workspace `overview.md` missing vision or constraints sections.** `.tenbo/overview.md` MUST contain the literal headers `## Vision` and `## Hard constraints` (matching the v2 enriched-overview wording). Match is case-sensitive, exact-prefix on a single line. Trailing whitespace is tolerated. The literal headers come from `templates/overview.md.tmpl`. Skip when `.tenbo/overview.md` is absent.

## Reporting

After running validation, the skill reports in plain language:
- **Errors** (rules 1–15, 24–28): block the user from considering the operation complete.
- **Warnings** (rules 16–19, 29–34, 46–54): surface to the user but do not block.

Example output:

> Validation: 2 errors, 1 warning.
> - ❌ Roadmap item `rm-014` references layer `visual-edtor` which doesn't exist (typo of `visual-editor`?).
> - ❌ Layer `ai-assistant.approval` has no narrative file at `.tenbo/scopes/editor/layers/ai-assistant.approval.md`.
> - ⚠️ Layer `persistence` description uses the word "API"; consider rephrasing.

20. **Plain-English jargon scrub** applies only to:
    - `description` fields in `architecture.yaml` and `roadmap.yaml`
    - The contents of each layer's `README.md`
    - The contents of `.tenbo/overview.md`
    Other `*.md` files (deep technical docs in layer dirs, files in `.tenbo/docs/`, files in `.tenbo/scopes/<scope>/docs/`) are exempt.

## Schema rules for v2 fields (links, notes, tenbo_item)

21. **`links:` paths** SHOULD point to files that exist on disk. If a referenced file is missing, warn: "item rm-NNN links to <path> which doesn't exist."
22. **`notes:` field** is free-form markdown; no validation.
23. **`tenbo_item:`** in plan/spec frontmatter SHOULD reference a real roadmap item. If not, warn: "<path> declares tenbo_item: rm-NNN which doesn't exist in any scope."

55. **`verification:`** is optional. When present, it must be an object with
    `status` equal to `not_required`, `pending_live`, `verified`, or `failed`.
    `evidence`, when present, must be a string array. `updated_at` and `note`,
    when present, must be strings.

## Phase tracking (optional `phases:` field)

A roadmap item MAY include an optional `phases:` list to track multi-phase work natively (instead of dated prose in `notes:`). When present:

- Each phase has required `id` (integer 1..N matching list position), `title`, and `status` (`now` | `next` | `later` | `done`).
- `completed_at` (YYYY-MM-DD) is optional but should be set when status becomes `done`.
- `notes` is optional freeform per-phase markdown.
- The item's top-level `status` is **derived** from phases:
  - `done`  if every phase is `done`
  - `now`   if any phase is `now`
  - else `next`  if any phase is `next`
  - else `later`

### Phase errors

35. **Phase id mismatch.** A phase's `id` MUST equal its 1-based position in the list. Errors when ids skip, repeat, or aren't integers.
36. **Phase missing required field.** Each phase MUST have a `title` and a valid `status`.
37. **Phase `completed_at` malformed.** When set, `completed_at` MUST match `YYYY-MM-DD`.

### Phase warnings

38. **Phase `done` without `completed_at`.** When a phase is `done`, `completed_at` SHOULD be set.
39. **Phase non-`done` with `completed_at`.** When `completed_at` is set, the status SHOULD be `done`.
40. **Item has both `status:` and `phases:`.** When phases are present the item-level status is derived; drop the explicit `status:` line.

## Relationship fields (optional `spawned_from:`, `superseded_by:`, and `related:`)

Roadmap items MAY include optional fields that record cross-task relationships
explicitly (instead of burying parent/peer trails in `notes:` prose):

- **`spawned_from`** — at most one id. The roadmap item that surfaced/dispatched this one.
- **`superseded_by`** — at most one id. The item that replaced this one. When set, the item's status must be `dropped`.
- **`related`** — a list of peer ids. Any number; order is not significant; not parent–child.

All follow the standard id pattern (`<prefix>-NNN` or `x-NNN`). An item may have
none, any, or all. Items without these fields render unchanged in the viewer.

Convention (Behavior 5 DoD): when a subagent's report surfaces a follow-up item,
the new item should set `spawned_from` to the item that triggered the dispatch.

### Phase-5 errors

41. **Relationship id format invalid.** `spawned_from`, `superseded_by`, and every
    entry in `related` must match `^[a-z]{1,5}-\d{3,}$`.
42. **Self-reference.** `spawned_from`/`superseded_by` must not equal the item's own
    id; `related` must not contain the item's own id.
46. **Supersession cycle.** A superseded_by B, B superseded_by A.

### Phase-5 warnings

43. **Unknown id reference.** `spawned_from`, `superseded_by`, or any entry in
    `related` references an id that doesn't exist in any scope's roadmap or in
    the cross-cutting roadmap. Warning (not error) because items may be tracked
    before the referenced item is created.
44. **Duplicate id in `related`.** Same id appears more than once in the list.
45. **Same id in both fields.** An id appears in both `spawned_from` and `related`
    on the same item (redundant — `spawned_from` already records the link).
47. **Superseded but not dropped.** An item has `superseded_by` set but status is
    not `dropped`.

## Adaptive onboarding rules (warnings)

50. **`maturity` field present and valid.** `workspace.yaml` SHOULD contain a `maturity` field with value `new`, `early`, `active`, or `mature`. Skip when field is absent (backwards compatible with pre-improvement repos).
51. **Stale `next` items.** A roadmap item with `status: next` whose most recent `notes:` timestamp (or `opened_at` if no notes) is older than `stale_next_days` from `principles.md` (default 30). Softer than stale `now` — informational only.
52. **`tenbo_sessions` is a non-negative integer.** When present in `workspace.yaml`, the value MUST be an integer ≥ 0. Skip when field is absent.
53. **`agent-context.md` is stale.** `.tenbo/agent-context.md` exists but its `Generated:` timestamp is older than the most recent modification to any `roadmap.yaml` in the workspace. Warn: "agent briefing is stale — will regenerate on next reconciliation." Skip when `agent-context.md` is absent.
54. **`.file-hashes.json` missing for active+ projects.** When `maturity` is `active` or `mature`, `.tenbo/.file-hashes.json` SHOULD exist. If absent, warn: "file-hash cache missing — drift detection at session start won't work until next reconciliation."

## Completion bar warnings

These rules check items already marked `done` against the completion bar (`references/completion-bar.md`). They surface retroactive bar failures so they remain visible after the fact. Warnings only — past `done` flips are not undone.

46. **Done item with `bar_override:` set.** Surface the override and its reason. Format: "item `<id>` flipped done with bar override: `<reason>`." Helps spot patterns of routine override (a smell that AC was wrong).
47. **Done item missing `doc_update`.** Required for feature/bug/refactor types. Already covered by item-schema convention; this rule makes it a formal warning surfaced in health checks. Skip for `spike` type.
48. **Done item with workpad still in `.tenbo/workpads/` (not archived).** Indicates either incomplete archival or an item that was flipped done out-of-band. Warn: "orphaned workpad for done item `<id>` — archive to `.tenbo/workpads/archive/`."
49. **Done substantial item without `workpad:` field.** A `done` item with `affects:` populated or 3+ `done_when:` bullets, but no `workpad:` field, suggests evidence was never produced through the bar. Skip when the item was created before workpads existed (heuristic: check `opened` date on archived workpad if accessible; otherwise skip silently for items completed pre-feature).
