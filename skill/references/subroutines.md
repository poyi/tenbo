# Tenbo Subroutines

Called from the internal domains. Never reference these by name in user-facing responses.

---

## Maturity Assessment

Run at the top of Initialize Project Memory and at session start (before the session gate).
Returns two classifications used by other subroutines and domains.

**Procedure:**

1. Count source files via `find` or glob walk (exclude `node_modules`, `vendor`, `dist`,
   `.git`, `.tenbo`). Record as `source_file_count`.
2. Check for existing docs: `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `docs/`.
3. Check for AI context files: `CLAUDE.md`, `.cursor/rules`, `AGENTS.md`, `GEMINI.md`.
4. Check `.tenbo/` state:
   - **absent** — no `.tenbo/` directory at all.
   - **skeleton** — `.tenbo/` exists but no scope has a populated `intent.md` (only
     template stubs or empty files).
   - **partial** — at least one layer has a populated `intent.md`, but not all.
   - **full** — every layer referenced in `architecture.yaml` has a non-empty `intent.md`.
5. Return **repo size**: `empty` (0 source files) | `scaffold` (<5) | `small` (<20) |
   `medium` (<200) | `large` (≥200).
6. Return **tenbo state**: `absent` | `skeleton` | `partial` | `full`.

These classifications drive the session gate (SKILL.md "Before Starting Work"),
the init path choice (intent-first vs source-scan), and ceremony reduction.

---

## Loading Layer Constraints

When a domain step says "load layer constraints", it specifies a **tier** that
determines how much context to load. Default to the lowest sufficient tier.

### Tier 0 — Briefing only (~500 tokens)

Read `.tenbo/agent-context.md` only. Sufficient for: session briefing, routing
decisions, recommendations, status changes, simple captures.

If `agent-context.md` is absent or stale, fall back to reading `workspace.yaml`
+ all `roadmap.yaml` files (the pre-improvement behavior) and note that
`agent-context.md` should be regenerated.

### Tier 1 — Scope context (~1500 tokens)

Tier 0, plus:
1. `.tenbo/scopes/<scope>/architecture.yaml` — layer definitions and globs.
2. `.tenbo/scopes/<scope>/roadmap.yaml` — item statuses and metadata.

Sufficient for: item capture with layer classification, planning path triage,
completion status flips.

### Tier 2 — Full layer constraints (~3000+ tokens)

Tier 1, plus for the specific `<scope>/<layer>`:
1. `.tenbo/principles.md` — prose sections only; skip the threshold YAML block.
2. `.tenbo/scopes/<scope>/layers/<layer>/intent.md` — Responsibilities, Anti-responsibilities, Invariants.
3. `.tenbo/scopes/<scope>/layers/<layer>/code-map.md` — Entry-points section.
4. `.tenbo/.validation-status.json` filtered to this layer — outstanding warnings become working context.

Required for: audits, constraint checks, populate, completion bar, principle
self-checks.

If `intent.md` is empty or template-only, surface that to the user rather than
silently proceeding — constraints cannot be enforced without it.

**Auto-populate offer (Tier 2 only):** If `intent.md` is empty/template-only AND
the current task involves code in this layer, offer: "This area doesn't have
architecture docs yet. Want me to scan the code and draft them before we start?
Takes ~1 minute." If accepted, run Populate path for just this layer, then
continue the original task. If declined, proceed without constraints.

### Tier assignments by domain

- Session briefing → Tier 0
- Recommend path → Tier 0
- Capture path → Tier 1
- Project Summary → Tier 0 (escalate to Tier 1 for scope-specific questions)
- Plan path → Tier 2
- Completion and Sync → Tier 2
- Health Review → Tier 2
- Audit → Tier 2
- Populate → Tier 2

---

## Conflict Surfacing

Triggered opportunistically inside Completion and Sync, Health Review, and Populate and Plan when a conflict is noticed between `.tenbo/` content and other repo documentation (e.g., `CLAUDE.md`, `docs/`). Detection is opportunistic only — do not search proactively.

1. Do NOT silently update either side.
2. Prompt: "Conflict: tenbo says X. CLAUDE.md says Y. Which is canonical? (a) tenbo, (b) other, (c) something else."
3. Update the non-canonical source to match (or both, on (c) with user-supplied wording).
4. Append a one-line dated entry to the affected layer's `intent.md` Boundary decisions if layer-scoped, or to `.tenbo/observations.md` if cross-cutting.

---

## Layer-Doc Drift Capture

Triggered opportunistically whenever the agent is already reading a layer's source for a parent task. Do NOT open extra files just to check for drift — this subroutine is bounded to files already being read.

**What counts as a drift candidate:**
- A file referenced in `code-map.md` entry-points has been renamed, moved, or removed.
- A new top-level file in the layer's globs is structurally significant but not listed in `code-map.md`.
- A responsibility in `intent.md` no longer matches code reality.
- An anti-responsibility is being violated by current code (also route through audit `[anti-resp]` path so it becomes a roadmap candidate).
- `README.md` description no longer fits what the code actually does.
- A `dependencies.outbound`/`external` entry in `architecture.yaml` is stale.

**Procedure:**
1. Collect candidates during the parent task. Do NOT interrupt it.
2. Mechanical updates (renames, file adds/removes, dependency edge changes) → apply silently, report as a one-line summary at the end.
3. Judgment updates (intent wording, README rewrites) → surface at the end via the universal prompting rule.
4. Deferred candidates → `.tenbo/.pending-reconciliation.yaml`.

---

## Continuation Dispatch Decision

Triggered when Tenbo is about to dispatch work to a subagent for a roadmap item.

**Decision rule:**

1. Read the item's `workpad:` field. If absent → use **first-turn brief** (full context).
2. If present, read the workpad's `last_updated` frontmatter.
3. Compute `hours_since = now - last_updated`. Read `continuation_window_hours` from `principles.md` (default 24).
4. If `hours_since <= continuation_window_hours` AND the workpad has at least one unchecked Plan item AND prior subagent thread context is available in this session → use **continuation brief** (`templates/continuation-brief.md.tmpl`).
5. Otherwise → use **first-turn brief** (full context).

**First-turn brief contents** (from the dispatch template in SKILL.md):
item id, spec/done_when, workpad path if present, in-scope deliverables, out-of-scope, constraints, verification commands, doc-update requirement, completion-bar verification requirement, structured-report shape (9 sections).

**Continuation brief contents** (from `templates/continuation-brief.md.tmpl`):
item id + title, workpad path, current branch + sha, last-completed plan item, next-up plan item, reconciliation reminder, workpad protocol reminder, completion-bar reminder, out-of-scope routing reminder, structured-report shape with continuation flag.

**Edge cases:**
- Workpad exists but no prior worker-agent thread context (e.g., a new assistant session) → use first-turn brief regardless of `last_updated`. The continuation brief assumes prior thread context.
- Workpad's `last_updated` is in the future (clock skew) → treat as 0 hours; use continuation brief.
- All Plan items checked but `done_when:` not all met → workpad is stale or wrong; route through resume reconciliation in workpad-protocol.md before dispatch.

---

## Glossary Capture

Triggered opportunistically whenever source code or tenbo content is already being read for a parent task.

**What counts as a candidate:** A project-specific term (not generic English) that appears repeatedly or is structurally significant AND is either missing from `glossary.md` or used with a meaning that differs from its glossary entry.

1. Collect candidates during the parent task. Do NOT interrupt.
2. At the end, surface as a compact picker: "Glossary candidates: (a) 'Resolver' — used in 3 files but not in glossary. Add/skip?"
3. For each accepted candidate, draft a one-line gloss and confirm wording via the universal prompting rule. Append alphabetically to `glossary.md`.
4. If a term has a meaning conflict, route through the Conflict Surfacing subroutine instead.
5. Deferred candidates → `.tenbo/.pending-reconciliation.yaml`.
