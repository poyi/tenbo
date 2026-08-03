# Product

## Register

product

## Users

Tenbo serves developers and technical leads who build software with AI coding assistants, including teams coordinating several agents against one backlog. Agents need compact, deterministic project context and conflict-safe commands. Humans need to understand priorities, inspect history, triage work, and verify what the agents are doing without reading repository internals.

## Product Purpose

Tenbo is persistent project memory for AI-assisted development. It keeps architecture, roadmap state, planning documents, priorities, and completion evidence coherent across sessions and tools. Success means every authorized human or agent sees the same current plan, can retrieve only the context needed for a task, and can make an intentional change without losing history or creating a second source of truth.

## Brand Personality

Calm, precise, and durable. Tenbo should feel like a trusted engineering instrument: concise enough for daily use, explicit about state and uncertainty, and confident without becoming theatrical or bureaucratic.

## Anti-references

Tenbo should not resemble a generic enterprise project-management suite, a gamified productivity app, or an opaque chat-first assistant. Avoid decorative dashboards, vanity metrics, noisy notifications, hidden automation, and workflows that require humans to learn internal storage schemas.

## Design Principles

1. Make shared truth legible. Humans and agents should be able to identify the canonical state, its freshness, and its evidence immediately.
2. Preserve information density without becoming cryptic. Priorities, status, scope, relationships, and verification belong near the work they qualify.
3. Keep human and agent workflows symmetric. The dashboard and typed API are views over the same contracts, permissions, and history.
4. Make state transitions explicit and recoverable. Loading, conflicts, retries, partial connectivity, and destructive operations must never be ambiguous.
5. Optimize for interruption and return. A user should regain project orientation in minutes after a day, a month, or an agent handoff.

## Accessibility & Inclusion

Target WCAG 2.1 AA for the hosted dashboard. All primary roadmap and documentation workflows must be keyboard accessible, use visible focus treatment, preserve meaning without color alone, support reduced motion, and remain usable at narrow desktop and mobile widths. Dense data views should retain readable labels and predictable navigation for assistive technology.
