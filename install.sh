#!/usr/bin/env bash
# tenbo — one-line installer / updater.
#
# Detects which AI coding agents are on your machine and installs tenbo for
# each one (Claude Code skill, Cursor rule package), plus optionally the
# tenbo-dashboard companion CLI/web app. Skips agents that aren't installed.
# Safe to re-run — running again pulls the latest from GitHub and npm.
#
# One line (current main):
#   curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/main/install.sh | bash
#
# Pinned to a release tag (recommended for reproducibility):
#   curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/v0.4.0/install.sh | bash
#
# What does it actually do? Run with `--dry-run` first if you want to know:
#   curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/main/install.sh | bash -s -- --dry-run
#
# Run with `--help` for the full reference.
#
# Bash 3.2 safe (works on macOS default bash) — no associative arrays.
# Inspired by caveman's install.sh (https://github.com/JuliusBrussee/caveman),
# adapted to tenbo's smaller scope (Claude Code + Cursor today).

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────
REPO="poyi/tenbo"
REF="${TENBO_REF:-main}"  # override with TENBO_REF=v0.4.0 to pin a tag
RAW_BASE="https://raw.githubusercontent.com/$REPO/$REF"
GIT_URL="https://github.com/$REPO.git"
DASHBOARD_PKG="tenbo-dashboard"

# ── Flags + state ──────────────────────────────────────────────────────────
DRY=0
LIST_ONLY=0
NO_COLOR=0
WITH_DASHBOARD=auto    # auto = ON unless --minimal
MINIMAL=0
ONLY=()

INSTALLED_IDS=()
SKIPPED_IDS=()
SKIPPED_WHY=()
FAILED_IDS=()
FAILED_WHY=()
DETECTED_COUNT=0

# Disable color on non-TTY by default.
if [ ! -t 1 ]; then NO_COLOR=1; fi

# ── Argument parsing ───────────────────────────────────────────────────────
print_help() {
  cat <<'EOF'
tenbo installer — detects your editor(s) and installs tenbo for each one.

USAGE
  install.sh [flags]

  curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/main/install.sh | bash -s -- --dry-run

FLAGS
  --dry-run             Print what would run, do nothing.
  --only <editor>       Install only for the named editor. Repeatable.
                        Editors: claude, cursor.
  --with-dashboard      Also install the tenbo-dashboard npm package globally.
                        On by default — pass --minimal to skip.
  --minimal             Just the editor packages. Skips dashboard install.
  --list                Print the editor matrix and exit.
  --no-color            Disable ANSI color codes (auto-disabled on non-TTY).
  -h, --help            Show this help and exit.

ENV
  TENBO_REF             Git ref to pull from (default: main). Set to a tag
                        for reproducibility, e.g. TENBO_REF=v0.4.0.

EDITORS DETECTED
  claude   Claude Code     installs skill at .claude/skills/tenbo/
  cursor   Cursor          installs rule at .cursor/rules/tenbo*.mdc

ALSO INSTALLED (default — disable with --minimal)
  tenbo-dashboard         npm package (CLI + local web dashboard)

URLS THE INSTALLER MAY FETCH FROM
  https://github.com/poyi/tenbo.git           (git clone)
  https://registry.npmjs.org/tenbo-dashboard  (via npm install -g)

EXAMPLES
  install.sh                              # default: all detected editors + dashboard
  install.sh --dry-run                    # show what would happen
  install.sh --minimal                    # editors only, skip dashboard
  install.sh --only cursor                # just install for Cursor
  install.sh --only claude --only cursor  # explicitly both
  install.sh --list                       # show the matrix and exit

  # Pin to a release tag instead of main:
  TENBO_REF=v0.4.0 curl -fsSL https://raw.githubusercontent.com/poyi/tenbo/v0.4.0/install.sh | bash
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)         DRY=1 ;;
    --with-dashboard)  WITH_DASHBOARD=1 ;;
    --minimal)         MINIMAL=1 ;;
    --list)            LIST_ONLY=1 ;;
    --no-color)        NO_COLOR=1 ;;
    --only)
      shift
      if [ $# -eq 0 ]; then
        echo "error: --only requires an argument" >&2
        exit 2
      fi
      ONLY+=("$1") ;;
    -h|--help)         print_help; exit 0 ;;
    *)
      echo "error: unknown flag: $1" >&2
      echo "run with --help for usage" >&2
      exit 2 ;;
  esac
  shift
done

if [ "$MINIMAL" = 1 ]; then
  WITH_DASHBOARD=0
fi
[ "$WITH_DASHBOARD" = "auto" ] && WITH_DASHBOARD=1

# ── Color helpers ──────────────────────────────────────────────────────────
if [ "$NO_COLOR" = 1 ]; then
  c_blue=""; c_dim=""; c_red=""; c_green=""; c_reset=""
else
  c_blue=$'\033[38;5;39m'
  c_dim=$'\033[2m'
  c_red=$'\033[31m'
  c_green=$'\033[32m'
  c_reset=$'\033[0m'
fi

say()  { printf '%s%s%s\n' "$c_blue" "$1" "$c_reset"; }
note() { printf '%s%s%s\n' "$c_dim" "$1" "$c_reset"; }
warn() { printf '%s%s%s\n' "$c_red" "$1" "$c_reset" >&2; }
ok()   { printf '%s%s%s\n' "$c_green" "$1" "$c_reset"; }

# ── Helpers ────────────────────────────────────────────────────────────────
want() {
  if [ ${#ONLY[@]} -eq 0 ]; then return 0; fi
  local a
  for a in "${ONLY[@]}"; do [ "$a" = "$1" ] && return 0; done
  return 1
}

run() {
  if [ "$DRY" = 1 ]; then
    note "  would run: $*"
    return 0
  fi
  echo "  $ $*"
  "$@"
}

has() { command -v "$1" >/dev/null 2>&1; }

record_installed() { INSTALLED_IDS+=("$1"); }
record_skipped()   { SKIPPED_IDS+=("$1"); SKIPPED_WHY+=("$2"); }
record_failed()    { FAILED_IDS+=("$1");  FAILED_WHY+=("$2"); }

# ── Editor matrix ──────────────────────────────────────────────────────────
# id | label | install path | detection probes
EDITOR_IDS=("claude" "cursor")
EDITOR_LABELS=("Claude Code" "Cursor")
EDITOR_INSTALL_PATHS=(".claude/skills/tenbo/" ".cursor/rules/")
EDITOR_DETECT=(
  "command:claude||dir:.claude/skills"
  "command:cursor||dir:.cursor/rules||dir:$HOME/.cursor"
)

# ── --list output ──────────────────────────────────────────────────────────
if [ "$LIST_ONLY" = 1 ]; then
  say "🪨 tenbo editor matrix"
  printf '\n  %-8s %-15s %s\n' "ID" "EDITOR" "INSTALL PATH"
  printf '  %-8s %-15s %s\n'   "----" "------" "-------------"
  i=0
  total=${#EDITOR_IDS[@]}
  while [ $i -lt "$total" ]; do
    printf '  %-8s %-15s %s\n' "${EDITOR_IDS[$i]}" "${EDITOR_LABELS[$i]}" "${EDITOR_INSTALL_PATHS[$i]}"
    i=$((i + 1))
  done
  echo
  note "  Detection probes per editor live in install.sh EDITOR_DETECT."
  note "  Default: --with-dashboard ON. Pass --minimal to skip."
  echo
  exit 0
fi

# ── Detection ──────────────────────────────────────────────────────────────
# Detection probe syntax (`||`-separated alternatives):
#   command:<bin>   binary on PATH
#   dir:<path>      directory exists (relative to $PWD or absolute)
#   file:<path>     file exists
detect_one() {
  local probes="$1"
  local clause
  IFS='||' read -ra CLAUSES <<< "$probes"
  # Bash splits "||" into empty fragments — filter them.
  for clause in "${CLAUSES[@]}"; do
    [ -z "$clause" ] && continue
    case "$clause" in
      command:*)
        local bin="${clause#command:}"
        if has "$bin"; then return 0; fi ;;
      dir:*)
        local d="${clause#dir:}"
        if [ -d "$d" ]; then return 0; fi ;;
      file:*)
        local f="${clause#file:}"
        if [ -f "$f" ]; then return 0; fi ;;
    esac
  done
  return 1
}

# ── Source fetch (for the cp-based installs) ───────────────────────────────
# Clone tenbo to a temp dir once; install_* functions copy from it.
TMP_TENBO=""
ensure_source() {
  if [ -n "$TMP_TENBO" ] && [ -d "$TMP_TENBO/skill" ]; then return 0; fi
  if ! has git; then
    warn "  git is required — install git and re-run."
    return 1
  fi
  TMP_TENBO="$(mktemp -d)/tenbo"
  if [ "$DRY" = 1 ]; then
    note "  would run: git clone --depth 1 -b $REF $GIT_URL $TMP_TENBO"
    # In dry-run, fake a directory so install_* can show their own would-runs.
    mkdir -p "$TMP_TENBO"/{skill,cursor}
    return 0
  fi
  echo "  $ git clone --depth 1 -b $REF $GIT_URL $TMP_TENBO"
  if ! git clone --depth 1 -b "$REF" "$GIT_URL" "$TMP_TENBO" >/dev/null 2>&1; then
    warn "  git clone failed (ref: $REF)"
    return 1
  fi
}

# ── Per-editor install functions ───────────────────────────────────────────
install_claude() {
  if ! ensure_source; then
    record_failed "claude" "could not fetch source from GitHub"
    return
  fi
  run mkdir -p .claude/skills
  run rm -rf .claude/skills/tenbo
  run cp -r "$TMP_TENBO/skill" .claude/skills/tenbo
  record_installed "claude"
  ok "  ✔ Claude Code skill installed at .claude/skills/tenbo/"
}

install_cursor() {
  if ! ensure_source; then
    record_failed "cursor" "could not fetch source from GitHub"
    return
  fi
  run mkdir -p .cursor/rules
  # Clean any prior tenbo* files first to avoid orphan rules from old layouts.
  if [ "$DRY" = 1 ]; then
    note "  would run: rm -f .cursor/rules/tenbo*.mdc .cursor/rules/tenbo-VERSION"
    note "  would run: rm -rf .cursor/rules/tenbo-templates"
  else
    rm -f .cursor/rules/tenbo*.mdc .cursor/rules/tenbo-VERSION 2>/dev/null || true
    rm -rf .cursor/rules/tenbo-templates 2>/dev/null || true
  fi
  # `/.` to copy contents of cursor/ (not the directory itself).
  run cp -r "$TMP_TENBO/cursor/." .cursor/rules/
  record_installed "cursor"
  ok "  ✔ Cursor rule installed at .cursor/rules/tenbo*.mdc"
}

install_dashboard() {
  if ! has npm; then
    record_failed "tenbo-dashboard" "npm not found — install Node.js (https://nodejs.org)"
    return
  fi
  run npm install -g "$DASHBOARD_PKG@latest"
  record_installed "tenbo-dashboard"
  ok "  ✔ tenbo-dashboard installed (run: npx tenbo-dashboard)"

  # Check for stale npx cache: the version npx resolves may differ from what
  # npm just installed globally (npx has its own cache in ~/.npm/_npx/).
  if [ "$DRY" = 0 ] && has npx; then
    cached_ver=$(npx --no-install "$DASHBOARD_PKG" --version 2>/dev/null || true)
    latest_ver=$(npm view "$DASHBOARD_PKG" version 2>/dev/null || true)
    if [ -n "$cached_ver" ] && [ -n "$latest_ver" ] && [ "$cached_ver" != "$latest_ver" ]; then
      warn "  ⚠ npx cache is stale: npx resolves v$cached_ver but latest is v$latest_ver"
      warn "    Fix: run 'npx clear-npx-cache' or use 'npx $DASHBOARD_PKG@latest'"
    fi
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────
say "🪨 tenbo installer (ref: $REF)"
echo
note "  Run with --dry-run first if you want to see what this script does"
note "  without actually changing anything."
echo

# Walk the editor matrix.
i=0
total=${#EDITOR_IDS[@]}
while [ $i -lt "$total" ]; do
  id="${EDITOR_IDS[$i]}"
  label="${EDITOR_LABELS[$i]}"
  detect="${EDITOR_DETECT[$i]}"

  if want "$id"; then
    if detect_one "$detect"; then
      DETECTED_COUNT=$((DETECTED_COUNT + 1))
      echo "→ $label detected"
      case "$id" in
        claude)  install_claude ;;
        cursor)  install_cursor ;;
      esac
    else
      record_skipped "$id" "not detected"
      note "○ $label not detected — skipping"
    fi
  fi
  i=$((i + 1))
done

if [ "$WITH_DASHBOARD" = 1 ]; then
  echo
  echo "→ tenbo-dashboard (companion CLI + web)"
  install_dashboard
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo
say "Summary"

if [ ${#INSTALLED_IDS[@]} -gt 0 ]; then
  ok "  installed:"
  for id in "${INSTALLED_IDS[@]}"; do echo "    • $id"; done
fi

if [ ${#SKIPPED_IDS[@]} -gt 0 ]; then
  note "  skipped:"
  i=0
  while [ $i -lt ${#SKIPPED_IDS[@]} ]; do
    note "    • ${SKIPPED_IDS[$i]} — ${SKIPPED_WHY[$i]}"
    i=$((i + 1))
  done
fi

if [ ${#FAILED_IDS[@]} -gt 0 ]; then
  warn "  failed:"
  i=0
  while [ $i -lt ${#FAILED_IDS[@]} ]; do
    warn "    ✗ ${FAILED_IDS[$i]} — ${FAILED_WHY[$i]}"
    i=$((i + 1))
  done
fi

# Cleanup the temp clone.
if [ -n "$TMP_TENBO" ] && [ -d "$TMP_TENBO" ] && [ "$DRY" = 0 ]; then
  rm -rf "$(dirname "$TMP_TENBO")"
fi

if [ "$DETECTED_COUNT" = 0 ] && [ ${#ONLY[@]} -eq 0 ]; then
  echo
  warn "No supported editors detected."
  warn "tenbo currently supports: Claude Code, Cursor."
  warn "Install one of those first, or pass --only <editor> to force install."
  exit 1
fi

if [ ${#FAILED_IDS[@]} -gt 0 ]; then
  exit 1
fi

echo
ok "Done. Open your editor in a project directory and ask: 'set up tenbo'."
