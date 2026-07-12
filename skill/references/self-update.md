# Self-Update

*Internal procedure — referenced from SKILL.md "Internal Capability Domains".*

*Maps to: "update tenbo", "check for tenbo updates", "is tenbo up to date?"*

Tenbo has up to FOUR update surfaces: the Claude Code skill (`.claude/skills/tenbo/`),
the Codex skill (`$CODEX_HOME/skills/tenbo` or `~/.codex/skills/tenbo`), the Cursor
rule package (`.cursor/rules/tenbo*.mdc`), and the dashboard CLI (npm).
Self-Update detects which surfaces exist locally, checks each against its remote, and
keeps them in lockstep so a fresh-skill/rule + stale-dashboard combination cannot cause
silent "command not found" failures inside init.

### VERSION file format

Both `skill/VERSION` and `cursor/VERSION` are YAML with two fields. The same min_dashboard
floor applies to both surfaces.
```yaml
# skill/VERSION
skill: 0.3.0
min_dashboard: 0.3.0
```
```yaml
# cursor/VERSION
rule: 0.3.0
min_dashboard: 0.3.0
```
- `skill:` / `rule:` — the package's own semver.
- `min_dashboard:` — the lowest dashboard CLI version this package is known to work with.
  Bumped only when the package begins requiring a new CLI command or behavior.

### Procedure

1. **Detect installed surfaces.**
   - Claude Code skill installed if `.claude/skills/tenbo/` exists.
   - Codex skill installed if `$CODEX_HOME/skills/tenbo/` exists, or if `CODEX_HOME`
     is unset and `~/.codex/skills/tenbo/` exists. Record the detected path as
     `CODEX_SKILL_PATH`.
   - Cursor rule installed if `.cursor/rules/tenbo.mdc` exists (or any `tenbo*.mdc` in that dir).
   - Dashboard installed if `npx --no-install tenbo-dashboard --version` returns cleanly.
2. **Read local versions** for each detected surface.
   - Claude Code skill: parse `.claude/skills/tenbo/VERSION`.
   - Codex skill: parse the detected Codex skill path's `VERSION`.
   - Cursor: parse `.cursor/rules/tenbo-VERSION` (named with the `tenbo-` prefix to avoid
     collision with other rule packages installed in the same `.cursor/rules/` directory).
   - Dashboard: `npx --no-install tenbo-dashboard --version`.
3. **Fetch remote versions.**
   - Skill packages: `curl -sL --max-time 5 https://raw.githubusercontent.com/poyi/tenbo/main/skill/VERSION`.
   - Cursor: `curl -sL --max-time 5 https://raw.githubusercontent.com/poyi/tenbo/main/cursor/VERSION`.
   - Dashboard: `npm view tenbo-dashboard version --json` (5s timeout). On network failure
     for any surface: report and continue with the surfaces that succeeded.
   - Tolerate legacy single-line VERSION files (treat whole file as `skill:`/`rule:` and
     assume `min_dashboard: 0.0.0`).
4. **Compare with semver, not string equality.** Use the standard precedence (0.3.0 > 0.2.5).
5. **Compute the action.**
   - Each detected surface behind its remote → propose update for that surface.
   - Any package's remote `min_dashboard` > installed dashboard → REQUIRE dashboard update
     first (or refuse the package update with: "Updating the [skill/rule] to v[new] requires
     dashboard ≥ v[min]. You have v[have]. Update dashboard first?").
   - Dashboard not installed at all → flag in the report; do not block other updates.
   - All up to date → "tenbo is up to date (skill v[s], rule v[r], dashboard v[d])." Stop.
6. **Confirm with the user.** One message listing what will change:
   *"Updates available: skill v[old] → v[new], rule v[old] → v[new], dashboard v[old] → v[new]. Apply?"*
7. **On confirmation, run updates in this order:**
   a. **Dashboard first** (if needed). Detect install scope:
      - Global: `npm install -g tenbo-dashboard@latest`. On EACCES, suggest `sudo` or
        the local-install fallback; do not auto-elevate.
      - Local-to-project: `npm install tenbo-dashboard@latest --prefix <project>` if a
        local install is detected.
      - If `npm` itself is missing: report and stop.
   b. **Skill / rule second** (if needed). For each surface that needs updating:
      ```
      git clone --depth 1 https://github.com/poyi/tenbo.git /tmp/tenbo-update
      # Claude Code skill, if installed:
      cp -r /tmp/tenbo-update/skill/. .claude/skills/tenbo/
      # Codex skill, if installed:
      cp -r /tmp/tenbo-update/skill/. "$CODEX_SKILL_PATH/"
      # Cursor rule, if installed:
      cp -r /tmp/tenbo-update/cursor/. .cursor/rules/    # flat copy of all .mdc + templates
      rm -rf /tmp/tenbo-update
      ```
8. **Verify.** Re-read all updated versions. Report: *"Updated: skill v[new], rule v[new], dashboard v[new]."*
   If a step failed, report which one and what to do.

The update only replaces skill / rule package files and the `tenbo-dashboard` package binary.
It never touches the project's `.tenbo/` directory — all project data is safe.
