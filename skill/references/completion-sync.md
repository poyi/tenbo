# Completion and Sync

*Internal procedure — referenced from SKILL.md "Internal Capability Domains".*

*Maps to: "I finished X", "just shipped X", or after any coding task.*

**Short-circuit gate — run FIRST:**
1. If `.tenbo/` does not exist → exit silently.
2. `git diff --name-only`: if no changed paths intersect any layer's `files` globs → exit silently.
3. Proceed only when at least one path matches.

## No roadmap item

Run `references/reconciliation.md`. Mechanical updates apply silently with a one-line
summary. Judgment calls use the universal prompting rule.

## Maps to a roadmap item (agent coded directly)

> **Gate:** `status: done` flips only after the completion bar passes
> (`references/completion-bar.md`). Steps 1–6 produce the evidence the bar checks;
> step 7 runs the bar; step 8 marks done.

1. **Test prompt** (feature/bug only). "Does this have a test? Want a reminder?" Non-blocking.
2. **Layer narrative.** Re-read `README.md`. Edit only if it no longer fits. Skip for internal changes.
3. **Architectural content** (universal prompting rule for judgment):
   - Responsibilities/boundaries changed → edit `intent.md`.
   - Files added/removed/renamed or deps changed → update `code-map.md` mechanically.
   - Structural shift → append dated boundary-decision entry to `intent.md`.
   - Per layer in `affects:`: repeat steps 2–3 only.
   - **Stamp `doc_update`:** edited → ISO date. Internal-only → `skipped — <reason>`.
4. **Validate.** Diff against prior snapshot; surface only new warnings.
5. **Principle self-check.** Load layer constraints (see subroutine). Surface violations
   with exact rule quoted.
6. **Run reconciliation** (`references/reconciliation.md`).
7. **Run the completion bar** (`references/completion-bar.md`). All rules must pass.
   On failure: surface the specific rule, fix or seek user input, re-run the bar.
   On override: user must explicitly invoke; record `bar_override: <reason>` on the row.
8. **Mark done.** Set `status: done`. Archive spec if `links:` points into `.tenbo/specs/`.
   Archive workpad to `.tenbo/workpads/archive/<item-id>.md` if present.
   Phased: mark only the matching phase; archive spec/workpad when all phases done.
9. **Refresh tenbo state.** Run `npx tenbo-dashboard sync --scope <scope-id>` (or
   plain `sync` if changes spanned multiple scopes). This recomputes metrics,
   re-runs init-check, re-validates, AND surfaces any NEW critical/warning findings
   inline — in one command. Without this, the dashboard's Health page (and the
   next session's briefing) will show stale data. Cheap — do not skip.
10. **Health note.** If `sync` reported new findings: pass the most severe 1–2 lines
    through verbatim as a one-liner to the user. At most once per session.
11. **Summarize.** One sentence: "Save system marked complete. Housing is now unblocked."

## Rework path

*Maps to: "this approach isn't working", "let's start over on X", or after explicit user
direction to reset.*

When a user invokes rework on an item:
1. Confirm intent (rework is a hard reset, not a course correction).
2. Bump `dispatch_attempts` on the row (init to 1 if absent).
3. Move the existing workpad to `.tenbo/workpads/archive/<item-id>-attempt-<N>.md` where
   `<N>` is the prior `dispatch_attempts` value.
4. Create a fresh workpad from the template. Auto-prepend a "Lessons from prior attempt(s)"
   section using the archived workpad's Confusions and trailing Notes (see
   `references/workpad-protocol.md` → "Rework handling").
5. Reset Plan and AC checkboxes (AC text seeds from current `done_when:`).
6. Surface to the user: "Reset workpad. Lessons from attempt N at the top. Continue?"
7. If `dispatch_attempts >= 3` after the bump, surface the chronic-rework warning (validator
   rule). The item may need scoping change or design rethink, not another attempt.

## Subagent coded the work

Work from the structured report. **Branch on continuation flag first:**

- **Continuation report** (partial progress expected). The subagent finished a turn but
  hasn't completed all `done_when:` bullets. Item stays `now`. Steps:
  1. Verify workpad updates: Plan checkboxes match what the report claims; Notes entry appended.
  2. Apply mechanical doc updates from the report (code-map.md row adds/removes).
  3. Surface follow-ups (noticed but not fixed) — fold, create new item, or discard.
  4. Ask: "Continue with another turn, or stop here?" Don't run the bar yet.

- **Final report** (subagent claims work is complete). Steps:
  1. Verify subagent's bar claims (report's per-rule `passed`/`n/a`/`failed` statements).
     Cross-check `done_when` evidence; check matching workpad ACs.
  2. Narrative update if approach changed what the layer does.
  3. Boundary decision entry if report shows structural shift.
  4. `doc_update` stamp: subagent edited → verify + stamp date. Subagent declined with reason →
     cross-check files list; if claim holds, stamp `skipped — <reason>`. Report omits field →
     deliverable failure; re-dispatch or apply yourself before flipping to done.
  5. Glossary candidates (see subroutine). Validate. Principle self-check. Run reconciliation.
  6. **Run the completion bar.** On failure → re-dispatch with the specific gap, or apply
     yourself before proceeding. Override only on explicit user direction (record `bar_override:`).
  7. **Mark done.** Set `status: done`. Test prompt (feature/bug only). Archive spec and workpad.
  8. Follow-ups (formal protocol): for each "noticed but not fixed" entry in the report,
     run classification heuristics → propose layer/scope; generate a fully-enriched item
     (id, title, description, type, priority, `files_to_read`, `done_when`, `risks`); set
     `spawned_from: <current-item-id>`. Present as a batch picker: "(a) accept all,
     (b) reject all, (c) review one-by-one." Accepted items append to the appropriate
     roadmap; rejected entries are discarded — no ghost retention.

**Dispatch template.** Choose first-turn or continuation per the continuation-dispatch
subroutine (see `references/subroutines.md` → "Continuation Dispatch Decision").

**First-turn brief.** When the item is dispatched fresh (no active workpad, or workpad stale,
or no prior subagent thread context), include: item id, spec/done_when, workpad path if
present (subagent updates Plan checkboxes and appends Notes during work), in-scope
deliverables, out-of-scope, constraints, verification commands, doc-update requirement
("update code-map.md and intent.md if surfaces changed; say so explicitly if internal-only"),
completion-bar verification requirement (`references/completion-bar.md` — subagent reports
`passed` / `n/a` / `failed: <reason>` per bar rule), and request a structured report with:
(1) files changed, (2) approach, (3) acceptance criteria status, (4) verification result,
(5) noticed but not fixed, (6) open questions, (7) doc updates applied or "no surface
changed because <reason>", (8) workpad sections updated, (9) completion bar status per rule.

**Continuation brief.** When the item has an active workpad within `continuation_window_hours`
and prior subagent thread context exists, render `templates/continuation-brief.md.tmpl` instead.
The continuation brief is terse — it points to the workpad as state and assumes the original
brief is in thread history. Same structured-report shape, plus continuation flag.
