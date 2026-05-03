# tenbo

[![npm](https://img.shields.io/npm/v/tenbo-dashboard)](https://www.npmjs.com/package/tenbo-dashboard)

An agentic project manager for AI-assisted coding. tenbo gives your AI coding assistant a persistent project memory — it tracks architecture, roadmaps, and priorities so you can build fast without losing the plot.

## The problem

AI-assisted coding lets you ship features fast. But speed creates a new problem: **projects drift.**

- Architecture decisions are made in chat and forgotten by the next session
- Boundaries between components blur as the AI takes shortcuts to get things working
- Features get half-built, parked, and never revisited
- No one tracks what was built, why, or what's next
- The codebase grows but the shared understanding of it doesn't

After a few weeks of vibe coding, you have working software and zero navigability. Your AI can re-read the entire codebase to answer "what does this project do?" — but that costs thousands of tokens every session and still misses the decisions that shaped it.

## How tenbo helps

tenbo is a Claude Code skill that runs alongside your normal coding workflow. It watches what you build, maintains a structured map of your project, and keeps a living roadmap — all without you having to learn any commands or schemas.

- **Persistent memory across sessions.** Architecture decisions, roadmap items, and project context survive between conversations. Your AI assistant starts every session knowing where you left off.
- **Automatic structure maintenance.** As you code, tenbo silently updates architecture docs, dependency maps, and code maps. Drift is caught early, not after it's too late.
- **Living roadmap.** Ideas, tasks, and priorities tracked in plain YAML. Items flow from "later" to "now" to "done" with acceptance criteria and completion checks.
- **Health signals.** Stale items, orphaned layers, threshold violations, and architectural drift are surfaced proactively — not buried in tech debt.
- **Natural language interface.** Just talk: "what should I build next?", "this is getting messy", "finished the auth system". No commands to memorize.

## What's in this repo

- **`skill/`** — The Claude Code skill (SKILL.md + references + templates). This is the core of tenbo.
- **`tenbo-dashboard/`** — An optional local web dashboard for visual roadmap browsing, item triage, and drag-reorder. Published to npm as `tenbo-dashboard`.

## Install the skill

```bash
# From your project directory
git clone https://github.com/poyi/tenbo.git /tmp/tenbo
cp -r /tmp/tenbo/skill/ .claude/skills/tenbo/
rm -rf /tmp/tenbo
```

That's it. Start a Claude Code session and tenbo will offer to map your project.

### What happens next

1. Claude detects the skill and offers to set up tenbo ("Want me to map the project structure?")
2. tenbo creates a `.tenbo/` directory in your repo with architecture docs, roadmaps, and layer definitions
3. From then on, tenbo listens for planning signals, tracks work, and maintains docs as you code

### Example prompts

```
"What should I build next?"
"Add OAuth support later"
"This code is getting messy"
"Finished the auth system"
"Can this scale to multiplayer?"
"Set up tenbo"
```

## Install the dashboard (optional)

![tenbo dashboard — kanban board view](docs/images/dashboard-kanban.png)

The dashboard gives you a visual UI for browsing roadmaps, triaging items, and reordering work.

```bash
# Run in your project directory (where .tenbo/ lives)
npx tenbo-dashboard
```

Opens at http://localhost:5174 (or the next available port). Reads and writes the same `.tenbo/` files — changes sync live with Claude.

### Dashboard CLI tools

```bash
npx tenbo-dashboard validate          # Run validation rules
npx tenbo-dashboard next-id <prefix>  # Allocate next roadmap item ID
npx tenbo-dashboard metrics --all     # Compute scope metrics
```

## How it works

tenbo maintains a `.tenbo/` directory in your repo:

```
.tenbo/
├── workspace.yaml          # Scopes, prefixes, project metadata
├── overview.md             # Project vision and constraints
├── principles.md           # Architectural principles
├── glossary.md             # Project-specific terminology
├── agent-context.md        # Session briefing (auto-generated)
├── roadmap.yaml            # Cross-cutting roadmap items
└── scopes/
    └── <scope>/
        ├── architecture.yaml   # Layers, file globs, dependencies
        ├── roadmap.yaml        # Scope-specific roadmap items
        └── layers/
            └── <layer>/
                ├── README.md       # Plain-English narrative
                ├── intent.md       # Responsibilities, boundaries, invariants
                └── code-map.md     # Entry points, key files, dependencies
```

All files are plain YAML and Markdown — human-readable, version-controlled, and editable by hand.

## Requirements

- **Skill**: Any project. Works with any language — Rust, Python, Go, TypeScript, etc. Requires [Claude Code](https://claude.ai/code).
- **Dashboard**: Node.js 18+.

## License

MIT. See [LICENSE](LICENSE).
