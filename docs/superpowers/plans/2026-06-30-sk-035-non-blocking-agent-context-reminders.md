# Non-Blocking Agent Context Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add advisory Tenbo context reminders that never block normal agent work.

**Architecture:** Define the behavior contract in skill/reference docs first, then add one dry-run-verifiable installer surface only if the context command is ready to advertise. Keep reminders as guidance, not enforcement.

**Tech Stack:** Markdown skill/rule docs, shell installer, Node CLI help/tests if a command surface is added.

## Global Constraints

- Build after `td-022` so the reminder points at a strong context command.
- Advisory only; no blocking hooks.
- Strict time budget and fail-open behavior for any executable hook.
- No interception of normal file reads.
- Installed surfaces must be included in update/uninstall guidance.

---

### Task 1: Define The Reminder Behavior Contract

**Files:**
- Modify: `skill/SKILL.md`
- Modify: `skill/references/subroutines.md`
- Modify: `cursor/tenbo.mdc`
- Modify: `cursor/tenbo-subroutines.mdc`

**Interfaces:**
- Produces: documented contract with advisory-only, fail-open, no-read-interception rules

- [ ] **Step 1: Add the contract text to skill docs**

Patch the session/context area with:

```md
Optional context reminders are advisory. They may point agents at
`npx tenbo-dashboard context feature --query "<request>" --json`, but they
must never block reads, edits, searches, or command execution. Every executable
reminder must fail open, keep a strict timeout, and avoid mutating project files.
```

- [ ] **Step 2: Mirror the text to Cursor rules**

Apply the same behavior contract to the matching `cursor/` files so installed surfaces do not diverge.

- [ ] **Step 3: Verify docs contain the contract**

Run:

```bash
rg -n "Optional context reminders are advisory|must never block reads" skill cursor
node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json
```

Expected: `rg` finds skill and cursor copies; validation has zero errors.

- [ ] **Step 4: Commit**

```bash
git add skill/SKILL.md skill/references/subroutines.md cursor/tenbo.mdc cursor/tenbo-subroutines.mdc
git commit -m "docs: define non-blocking context reminder contract"
```

### Task 2: Add A Dry-Run Reminder Script Generator

**Files:**
- Create: `tenbo-dashboard/scripts/reminder.ts`
- Create: `tenbo-dashboard/scripts/reminder.test.ts`
- Modify: `tenbo-dashboard/bin/tenbo-dashboard.mjs`

**Interfaces:**
- Produces: `renderSessionReminder(): string`
- Produces: CLI `tenbo-dashboard reminder print [--json]`

- [ ] **Step 1: Write failing tests for reminder text**

```ts
expect(renderSessionReminder()).toContain('tenbo-dashboard context feature');
expect(renderSessionReminder()).toContain('advisory');
expect(renderSessionReminder().length).toBeLessThan(500);
```

Add CLI test:

```ts
const result = runReminderCli(['print', '--json']);
expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, mode: 'print' });
```

- [ ] **Step 2: Run failing tests**

Run: `cd tenbo-dashboard && npm test -- scripts/reminder.test.ts --run`

Expected: FAIL because `reminder.ts` does not exist.

- [ ] **Step 3: Implement print-only reminder**

Add:

```ts
export function renderSessionReminder(): string {
  return 'Tenbo context reminder (advisory): if this repo has .tenbo/, prefer `npx tenbo-dashboard context feature --query "<request>" --json` before broad source search.';
}
```

Add `runReminderCli(args)` supporting only `print` in this task. Register `reminder` in the command map and help.

- [ ] **Step 4: Run reminder tests and help smoke check**

Run:

```bash
cd tenbo-dashboard
npm test -- scripts/reminder.test.ts --run
node bin/tenbo-dashboard.mjs help | rg "reminder"
```

Expected: PASS; help mentions reminder.

- [ ] **Step 5: Commit**

```bash
git add tenbo-dashboard/scripts/reminder.ts tenbo-dashboard/scripts/reminder.test.ts tenbo-dashboard/bin/tenbo-dashboard.mjs
git commit -m "feat: add advisory context reminder text"
```

### Task 3: Add Optional Install Guidance Without Auto-Writing Config

**Files:**
- Modify: `README.md`
- Modify: `install.sh`
- Modify: `skill/SKILL.md`
- Modify: `cursor/tenbo.mdc`

**Interfaces:**
- Consumes: `tenbo-dashboard reminder print`
- Produces: documented manual adapter guidance and explicit no-auto-install behavior

- [ ] **Step 1: Add README guidance**

Add:

```md
### Optional agent context reminders

Tenbo can print a short advisory reminder for agent session-start hooks:
`npx tenbo-dashboard reminder print`. This is guidance only. It does not block
tool calls, does not intercept file reads, and is not installed automatically.
Use your agent's hook system only if you want this reminder in every session.
```

- [ ] **Step 2: Make installer stance explicit**

In `install.sh --help`, add one line:

```text
Context reminders are not auto-installed; run `tenbo-dashboard reminder print` for manual hook text.
```

- [ ] **Step 3: Run docs/help checks**

Run:

```bash
rg -n "Context reminders are not auto-installed|Optional agent context reminders" README.md install.sh
bash install.sh --help | rg "Context reminders"
```

Expected: all commands find the text.

- [ ] **Step 4: Commit**

```bash
git add README.md install.sh skill/SKILL.md cursor/tenbo.mdc
git commit -m "docs: document optional context reminders"
```

### Task 4: Final Verification

**Files:**
- No new files beyond prior tasks

**Interfaces:**
- Consumes: reminder docs and CLI
- Produces: verified advisory reminder surface

- [ ] **Step 1: Run final checks**

Run:

```bash
node tenbo-dashboard/bin/tenbo-dashboard.mjs validate --json
cd tenbo-dashboard && npm test -- scripts/reminder.test.ts --run
cd tenbo-dashboard && npm run build
```

Expected: validation has zero errors; tests pass; build passes.

- [ ] **Step 2: Commit completion note if docs changed during verification**

If verification forced wording changes:

```bash
git add README.md install.sh skill/SKILL.md cursor/tenbo.mdc tenbo-dashboard/scripts/reminder.ts tenbo-dashboard/scripts/reminder.test.ts tenbo-dashboard/bin/tenbo-dashboard.mjs
git commit -m "chore: verify context reminder surface"
```

If no files changed, do not create an empty commit.

## Self-Review

- Spec coverage: Covers advisory behavior, no blocking, no file-read interception, docs, print-only command, and manual installation stance.
- Placeholder scan: No placeholders remain.
- Type consistency: `renderSessionReminder` and `runReminderCli` are consistently named.
