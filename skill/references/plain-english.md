# Plain-English discipline (full rules)

The skill body declares the rule; this file holds the enforceable detail. Loaded only when an agent is about to write user-facing tenbo content.

## The audience test

Every change to a `description` field or narrative MUST remain readable by a non-engineer. Self-check: would a PM reading this on a phone in 30 seconds understand it?

## Pre-write jargon scrub

Before writing any file in the in-scope list below, scan its content against the forbidden list. If a forbidden word appears, rewrite or confirm a rewrite with the user. Do NOT write files containing flagged jargon.

**Forbidden jargon (rewrite, don't use):** "module", "API", "endpoint", "interface", "abstraction", "service", "controller", "DTO", "ORM", "repository pattern", "middleware", "schema", "polyfill", "shim", "AST", "RPC", "webhook", "queue", "worker", "daemon".

If a concept genuinely needs a technical term, prefer naming it after what the user does ("the part that saves your work" rather than "the persistence layer", "a way to check generated code" rather than "an endpoint").

## No internal symbol names in user-facing prose

Sub-concerns, narratives, and `description` fields must NOT contain code identifiers, function names, type names, or backticks (e.g., `manage_tokens`, `someFunction()`, `UserDTO`). If you would write `someThing()`, find a non-symbol way to describe what it does. Backticks are reserved for the `files` globs only.

## In scope (rules apply)

- The `description` field on every layer in `architecture.yaml`.
- The `description` field on every roadmap item.
- Every layer's `README.md` (the plain-English narrative).
- `.tenbo/overview.md`.
- `.tenbo/principles.md` and `.tenbo/glossary.md` — workspace-level PM-facing docs. The jargon scrub applies to narrative prose; technical terms inside fenced code blocks (e.g., the YAML threshold block in principles.md) are exempt because they're machine-read.

## Out of scope (rules do NOT apply)

- Other `*.md` files inside layer directories (deep technical docs — jargon expected).
- Files in `.tenbo/docs/` or `.tenbo/scopes/<scope>/docs/` (engineering tier).
- The `notes:` field on roadmap items (freeform context).

Engineering tier docs are exempt because they need precise technical terms ("schema", "endpoint", "AST") to be useful.
