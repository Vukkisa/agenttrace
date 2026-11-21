#!/usr/bin/env bash
# Install (or remove) the global /agenttrace skill.
#
#   scripts/install-skill.sh              dry run: show what would happen
#   scripts/install-skill.sh --apply      copy the skill to ~/.claude/skills/agenttrace/
#   scripts/install-skill.sh --uninstall --apply   remove it again
#
# Safe by default: nothing changes without --apply. It only touches
# <skills dir>/agenttrace/SKILL.md, never MCP registrations or settings.
# An existing SKILL.md that is not AgentTrace's own is left alone unless
# --force is given, and is then backed up to SKILL.md.bak first.
# The skills directory defaults to ~/.claude/skills; override with
# CLAUDE_SKILLS_DIR (used by the tests).
set -euo pipefail

MARKER='agenttrace-skill'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/plugins/agenttrace/skills/agenttrace/SKILL.md"
DEST_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}/agenttrace"
DEST="$DEST_DIR/SKILL.md"

apply=0; force=0; uninstall=0
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    --force) force=1 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { if [ "$apply" -eq 1 ]; then echo "$1"; else echo "[dry run] would: $1"; fi; }
ours() { [ -f "$DEST" ] && grep -q "$MARKER" "$DEST"; }

if [ "$uninstall" -eq 1 ]; then
  if [ ! -f "$DEST" ]; then echo "Nothing to remove: $DEST does not exist."; exit 0; fi
  if ! ours && [ "$force" -ne 1 ]; then
    echo "Refusing: $DEST is not an AgentTrace skill file. Use --force to remove it anyway." >&2
    exit 1
  fi
  say "remove $DEST"
  if [ "$apply" -eq 1 ]; then
    rm -f "$DEST"
    rmdir "$DEST_DIR" 2>/dev/null || true
  else
    echo "Re-run with --apply to make the change."
  fi
  exit 0
fi

[ -f "$SRC" ] || { echo "Skill source not found: $SRC" >&2; exit 1; }

if [ -f "$DEST" ] && cmp -s "$SRC" "$DEST"; then
  echo "Already installed and up to date: $DEST"
  exit 0
fi

if [ -f "$DEST" ] && ! ours; then
  if [ "$force" -ne 1 ]; then
    echo "Refusing: $DEST already exists and is not an AgentTrace skill file." >&2
    echo "Use --force to replace it (the old file is saved as SKILL.md.bak)." >&2
    exit 1
  fi
  say "back up $DEST to $DEST.bak"
  [ "$apply" -eq 1 ] && cp -p "$DEST" "$DEST.bak"
fi

say "copy $SRC to $DEST"
if [ "$apply" -eq 1 ]; then
  mkdir -p "$DEST_DIR"
  cp "$SRC" "$DEST"
  echo "Installed. Restart Claude Code, then run /agenttrace."
  echo "The skill needs the AgentTrace MCP server (see README)."
else
  echo "Re-run with --apply to make the change."
fi
