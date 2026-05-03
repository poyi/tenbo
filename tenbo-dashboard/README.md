# tenbo-dashboard

Local architecture dashboard and CLI tools for [tenbo](https://github.com/poyi/tenbo) — an agentic project manager for AI-assisted coding.

![tenbo dashboard — kanban board view](https://raw.githubusercontent.com/poyi/tenbo/main/docs/images/dashboard-kanban.png)

## Quick start

```bash
# Run in any project with a .tenbo/ directory
npx tenbo-dashboard
```

Opens a local dashboard for browsing roadmaps, triaging items, and drag-reorder.

## CLI tools

```bash
npx tenbo-dashboard validate          # Run validation rules
npx tenbo-dashboard next-id <prefix>  # Allocate next roadmap item ID
npx tenbo-dashboard metrics --all     # Compute scope metrics
```

## What is tenbo?

tenbo is a Claude Code skill that gives your AI coding assistant persistent project memory — architecture docs, roadmaps, and health signals that survive across sessions. The dashboard is an optional visual companion.

Install the skill: [github.com/poyi/tenbo](https://github.com/poyi/tenbo)

## License

MIT
