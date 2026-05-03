# Optional file patterns

Tenbo's required per-layer files are `README.md`, `intent.md`, and `code-map.md`. Beyond those, several optional files MAY be created when the agent (or user) judges they help. These are agent-judged additions — the user can always override, suppress, or remove them.

Each optional file has a trigger heuristic (numeric where possible — see thresholds below) and a structure. Templates for the listed files live at `<this-skill>/templates/optional/`.

## Patterns

| File | Trigger heuristic | Structure | Template |
|---|---|---|---|
| `<layer>/decisions.md` | The "Boundary decisions" section in the layer's `intent.md` exceeds ~10 dated entries (count lines under that heading). | Move the section into its own file. `intent.md` keeps a one-line link to it. Same dated-line format. | `<this-skill>/templates/optional/decisions.md.tmpl` |
| `<layer>/open-questions.md` | The layer has at least one live ambiguity worth surfacing for brainstorm context (e.g., a question raised during reconciliation that the user deferred). Create on the first such item. | Bulleted list. Each bullet is a date and short context. Cleared as questions get answered. | `<this-skill>/templates/optional/open-questions.md.tmpl` |
| `<layer>/migrations.md` | The layer is mid-refactor (a `type: refactor` roadmap item with `status: now` is open against this layer). Transient — capture the in-flight plan. | Short narrative plus a checklist. Deleted when the refactor completes. | `<this-skill>/templates/optional/migrations.md.tmpl` |
| `.tenbo/open-questions.md` | Workspace-level ambiguity (cross-layer, product-level) that does not fit any single layer's `open-questions.md`. | Same shape as the per-layer file. | `<this-skill>/templates/optional/open-questions.md.tmpl` (reuse) |
| `<layer>/<feature>-deep-dive.md` | A topic in `code-map.md` would need more than ~50 lines of explanation if kept inline. | Free-form technical doc — engineering tier, jargon allowed. Linked from `code-map.md`'s "Deep dives" section. | None (freeform; no template). |

## Notes on triggers

- Trigger thresholds are heuristics. The agent applies the universal prompting rule when it is unsure whether a pattern applies — propose creating the file and let the user confirm.
- Treat workspace-level optional files like layer deep-dives — engineering-tier prose, no plain-English scrub.
- The deep-dive pattern has no template because shape varies too much. Use the existing technical doc style of the repo.

## Where templates live

All templates for the patterns above (except deep-dive, which is freeform) sit in `<this-skill>/templates/optional/`. When creating an optional file, render the corresponding template, then walk the user through filling it in section by section per the universal prompting rule.
