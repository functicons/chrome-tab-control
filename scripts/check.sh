#!/usr/bin/env bash
# check.sh — Verify required dependencies for Chrome Tab Control
#
# Usage: ./check.sh

set -euo pipefail

OK=1

check_pass() { echo "  ✅ $1"; }
check_fail() { echo "  ❌ $1"; OK=0; }
check_warn() { echo "  ⚠️  $1"; }

echo "Checking dependencies..."

# Node.js 22+
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")"
  if [ "${NODE_MAJOR}" -ge 22 ] 2>/dev/null; then
    check_pass "Node.js $(node --version) (>= 22 required)"
  else
    check_fail "Node.js $(node --version) — version 22+ required"
  fi
else
  check_fail "Node.js not found"
fi

# Google Chrome
if [ -d "/Applications/Google Chrome.app" ] || command -v google-chrome >/dev/null 2>&1; then
  check_pass "Google Chrome"
else
  check_fail "Google Chrome not found"
fi

# Native messaging host
MANIFEST=""
case "$(uname -s)" in
  Darwin) MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.cdp_tab_control.json" ;;
  Linux)  MANIFEST="${HOME}/.config/google-chrome/NativeMessagingHosts/com.anthropic.cdp_tab_control.json" ;;
esac
if [ -n "${MANIFEST}" ] && [ -f "${MANIFEST}" ]; then
  check_pass "Tab proxy installed"
else
  check_warn "Tab proxy not installed (run: make install-tab-proxy)"
fi

# Claude Code skill
if [ -f "${HOME}/.claude/skills/chrome-tab-control/SKILL.md" ]; then
  check_pass "Claude Code skill installed"
else
  check_warn "Claude Code skill not installed (run: make install-skill)"
fi

# Shared tabs
TABS="${HOME}/.chrome-tab-control/shared-tabs.json"
if [ -f "${TABS}" ] && [ "$(cat "${TABS}" 2>/dev/null)" != "[]" ] && [ -s "${TABS}" ]; then
  check_pass "Shared tabs found"
else
  check_warn "No shared tabs (open the Tab Control extension and share a tab)"
fi

echo ""
if [ "${OK}" -eq 0 ]; then
  echo "Some required dependencies are missing."
  exit 1
else
  echo "All required dependencies OK."
fi
