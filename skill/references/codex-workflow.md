# Codex Workflow

Use this adapter when Tenbo runs in Codex.

## Skill installation

- Codex skills install under `$CODEX_HOME/skills/tenbo` or, when `CODEX_HOME`
  is unset, `~/.codex/skills/tenbo`.
- Codex UI metadata lives at `agents/openai.yaml` inside the skill package.
- Keep user-facing responses plain. Codex may hide command output, but Tenbo
  should still summarize outcomes rather than internal file operations.

## Worker agents

- Dispatch worker agents with `spawn_agent` and collect results with
  `wait_agent`.
- Give each worker explicit, disjoint file ownership. Do not dispatch workers
  that may edit the same files unless the user explicitly chooses sequential
  execution.
- Workers are leaf executors: no nested subagents.
- The main conversation owns orchestration, roadmap status changes, validation,
  and final user-facing summaries unless the dispatch prompt states otherwise.

## Dispatch prompt essentials

Include the item id, title, acceptance criteria, files to read, files the worker
may edit, verification expected, and the structured report format Tenbo expects.
Tell the worker to avoid files outside its ownership and to report any blocked
or noticed-but-not-fixed work instead of broadening scope.
