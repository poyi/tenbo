# Micro-sync (proactive post-edit reconciliation)

*Internal procedure — fires automatically after code edits. No user prompt required.*

## Purpose

The full Completion and Sync procedure (12 steps) depends on intent classification
("I finished X") and is often skipped when users simply move on. Micro-sync is
the lightweight fallback: it keeps code-map and metrics fresh without requiring
the user to announce task boundaries.

## Trigger

Fire micro-sync when ALL of the following are true:

1. `.tenbo/` exists in the repo.
2. The agent just finished a coding task (wrote/edited implementation files — not
   just config, docs, or conversation).
3. The user has NOT explicitly said "I finished X" / "just shipped X" (if they did,
   route to full Completion and Sync instead).
4. At least one changed file intersects a layer's `files` globs.

**Threshold:** 3+ files edited, OR any new file created, OR any file deleted.
Below this threshold, skip silently — single-file typo fixes don't need reconciliation.

## Procedure (3 steps max — must complete in <5 seconds of agent time)

1. **Map changed files → layers.** Pattern-match against `architecture.yaml` globs.
   No layers affected → exit silently.

2. **Mechanical code-map update.** For each affected layer:
   - New file in glob but not in `code-map.md` → add row.
   - File renamed/deleted → update or remove row.
   - New external import → add to `architecture.yaml` `dependencies.external`.
   - New cross-layer import → add to `architecture.yaml` `dependencies.outbound`.
   - Run AST pattern extraction (`references/ast-patterns.md`) for changed files
     to detect new/removed exports. Update `code-map.md` entries mechanically.

3. **Quick validate + one-liner.** Run validation (in-memory, not CLI). If new
   warnings appear, surface one line. Otherwise:
   > Tenbo: synced code-map (N files updated).
   
   If zero mechanical changes were needed: exit silently. No output.

## What micro-sync does NOT do

- Does NOT flip item status to `done` (that requires the full completion bar).
- Does NOT update `intent.md` or layer narratives (those need judgment).
- Does NOT run the dependent sweep or archive specs/workpads.
- Does NOT prompt for boundary decisions or principle violations (those are
  deferred to `.tenbo/.pending-reconciliation.yaml` for next full sync).
- Does NOT regenerate `agent-context.md` (cheap but not urgent mid-session).

If micro-sync detects a potential intent drift (>50 changed lines in an entry
point, or new exported symbols), it appends to `.pending-reconciliation.yaml`
silently and moves on. The next full Completion and Sync (or session start) will
surface these.

## Relationship to full Completion and Sync

```
User says "finished X"  →  full Completion and Sync (12 steps, completion bar)
User just coded stuff   →  micro-sync (3 steps, mechanical only)
Neither triggered       →  nothing (drift accumulates until session start)
```

Micro-sync is a floor, not a ceiling. If the agent recognizes that a roadmap item
was clearly completed (all `done_when` bullets are evidently satisfied), it SHOULD
escalate to full Completion and Sync even without an explicit user signal. But
micro-sync guarantees that at minimum, code-map stays fresh.

## Token discipline

- Step 1 is free — file list already in context from the edit.
- Step 2 reads only `code-map.md` for affected layers (small files).
- Step 3 is in-memory validation — no file reads.
- Total budget: <500 tokens output. If you're writing more, you're doing too much.
