#!/usr/bin/env bash
# install-skill.sh — Install the chrome-tab-control skill to ~/.claude/skills/
#
# Usage: ./install-skill.sh
#
# Syncs the skill directory to ~/.claude/skills/chrome-tab-control/ so that
# Claude Code can discover and use it across all projects.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../skills/chrome-tab-control" && pwd)"
TARGET_DIR="${HOME}/.claude/skills/chrome-tab-control"

main() {
  mkdir -p "${TARGET_DIR}"
  rsync -av --delete "${SKILL_DIR}/" "${TARGET_DIR}/"
  echo ""
  echo "Skill installed to ${TARGET_DIR}"
}

main "$@"
