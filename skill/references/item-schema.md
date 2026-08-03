# Roadmap Item Fields

Optional fields items in `roadmap.yaml` may carry:

- `links:` — array of paths (relative to repo root) to plans/specs for this item.
- `notes:` — markdown string with timestamped context notes.
- `verification:` — optional object describing how proven the item is independently from implementation status. Shape: `{status, updated_at?, evidence?, note?}` where `status` is `not_required`, `pending_live`, `verified`, or `failed`; `evidence` is a list of command names, URLs, commit refs, or manual checks.
- `doc_update:` — ISO date (`2026-04-28`) or `skipped — <reason>`; required for `done` items of type feature/bug/refactor. The validator warns when absent.
- `spawned_from:` — id of the item that surfaced this one.
- `superseded_by:` — id of the item that replaced this one. Item must be `dropped`.
- `related:` — peer item ids (not parent–child).
- `phases:` — `[{ id, title, status, completed_at?, notes? }]` for multi-phase items. Item-level `status` is derived when `phases:` is present.
- `affects:` — `[layer-id]` (same scope) or `[scope-id:layer-id]` (cross-scope).
- `done_when:` — 1–3 bullets defining done. Each bullet is either a plain-English string,
  or a **structured, machine-checkable** entry (x-003):
  `{ text: "<criterion>", check: { run: "<shell command>", expect_exit: 0, timeout_ms: 60000 } }`.
  When a criterion maps to a deterministic command (build/test/lint), prefer the structured
  form so completion can be evidence-based. `expect_exit` defaults to 0; `timeout_ms` defaults
  to 60000 and is hard-capped at 300000. `npx tenbo-dashboard item verify <id> --check` runs
  the `check:` bullets (strict timeout, process-group kill) and records pass/fail evidence;
  the completion bar treats a failing check as blocking. Plain-string bullets are reported as
  `manual` — never auto-passed. Execution happens only on this explicit verify, never
  automatically.
- `files_to_read:` — repo-relative paths an implementer should read first.
- `risks:` — known unknowns or complicating factors.
- `priority:` — `p0` (critical) / `p1` (high) / `p2` (normal) / `p3` (low). Advisory only — does not affect ordering.
- `type:` — `feature` / `bug` / `refactor` / `spike`.
- `preflight_violations:` — optional list of `{check, outcome, decision, rationale}` recorded when capture accepts an item despite a pre-flight violation. See sk-029 for context. Validator surfaces accept-with-violation entries as a health observation; done/dropped items skip the warning.
- `goal_ref:` — array of goal IDs from `overview.md` (`[g1]`, `[g2, g3]`) OR the literal string `exploratory`. Default cardinality is **single primary** — one entry the rationale is anchored to. Use a multi-entry list only for genuinely cross-cutting items. Children may diverge from their parent's `goal_ref` if they advance a different goal — surface the divergence to the user at plan time. `exploratory` is the deliberate escape hatch for items captured without a clear goal connection; they're excluded from default Recommend output but visible in the dashboard. Missing entirely → validator warning (not error) — backwards-compatible.
- `workpad:` — repo-relative path to a workpad file (e.g., `.tenbo/workpads/ed-045.md`). Created for substantial items at plan-path triage. See `workpad-protocol.md`.
- `dispatch_attempts:` — integer, incremented when an item enters `rework` after a prior attempt failed. Validator surfaces items with `dispatch_attempts >= 3` to flag chronic difficulty. Items with status `rework` are mid-reset; the workpad has been archived and a fresh one created. See SKILL.md "Rework path".
- `bar_override:` — string reason set when the user explicitly bypasses the completion bar. Validator surfaces overridden items in health checks. See `completion-bar.md`.

**Spec files:** When creating a plan or spec, include `tenbo_item: <id>` in the file's frontmatter and append its path to the item's `links:`.

**Notes:** When the user adds context ("note on X: …"), append a timestamped bullet to `notes:`.

**Agent-safe CLI:** Use typed CLI commands for every item and planning-document
mutation. Cloud-configured projects never fall back to roadmap/spec/workpad files
after an API failure; local projects use the same commands with the local backend.

```bash
npx tenbo-dashboard item show <id> --json
npx tenbo-dashboard item allocate-id <prefix> --json
npx tenbo-dashboard item create <id> --scope <scope> --title "<title>" --description "<description>"
npx tenbo-dashboard item update <id> --patch '<json>'
npx tenbo-dashboard item set-status <id> <now|next|later|done|dropped>
npx tenbo-dashboard item add-note <id> "<note>"
npx tenbo-dashboard item verify <id> --status <not_required|pending_live|verified|failed> --evidence "<evidence>"
npx tenbo-dashboard item link-commit <id> <sha>
npx tenbo-dashboard item archive <id>
npx tenbo-dashboard item reopen <id>
npx tenbo-dashboard item claim <id> --owner <agent>
npx tenbo-dashboard item document-create <id> --kind <spec|workpad|handoff> --content-file <path>
npx tenbo-dashboard item document-archive <document-path>
npx tenbo-dashboard items --status <status> --verification <verification-status> --json
npx tenbo-dashboard next --json
```

**Workpad vs. notes:** `notes:` is for short context bullets the user dictates inline. `workpad:` is the structured living document Tenbo authors for substantial in-flight work. Lightweight items use `notes:` only; substantial items use both, with workpad as the durable execution state. Access cloud-canonical workpads through document commands/API DTOs, not filesystem paths.
