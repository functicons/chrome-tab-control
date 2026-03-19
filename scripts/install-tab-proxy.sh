#!/usr/bin/env bash
# install-tab-proxy.sh — Register the tab proxy so Chrome can launch it
#
# Usage: ./install-tab-proxy.sh
#
# This creates the native messaging host manifest so Chrome can launch
# the tab-proxy.mjs bridge process when the extension connects.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOST_NAME="com.functicons.chrome_tab_control"
EXTENSION_ID="kcmiikdjkildoflbadepjgmdecganjen"
SKILL_SCRIPTS="${REPO_DIR}/skills/chrome-tab-control/scripts"
HOST_WRAPPER="${SKILL_SCRIPTS}/tab-proxy-wrapper.sh"
HOST_SCRIPT="${SKILL_SCRIPTS}/tab-proxy.mjs"

main() {
  # Determine manifest directory based on platform
  local manifest_dir
  case "$(uname -s)" in
    Darwin)
      manifest_dir="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      ;;
    Linux)
      manifest_dir="${HOME}/.config/google-chrome/NativeMessagingHosts"
      ;;
    *)
      echo "Error: Unsupported platform $(uname -s)"
      exit 1
      ;;
  esac

  mkdir -p "${manifest_dir}"

  # Make scripts executable
  chmod +x "${HOST_WRAPPER}" "${HOST_SCRIPT}"

  # Write native messaging host manifest
  local manifest_file="${manifest_dir}/${HOST_NAME}.json"
  cat > "${manifest_file}" <<MANIFEST
{
  "name": "${HOST_NAME}",
  "description": "Tab Control — tab proxy for Chrome extension",
  "path": "${HOST_WRAPPER}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
MANIFEST

  echo "Tab proxy installed:"
  echo "  Manifest:  ${manifest_file}"
  echo "  Proxy:     ${HOST_WRAPPER}"
  echo "  Extension: ${EXTENSION_ID}"
  echo ""
  echo "Setup complete. Click the Tab Control extension icon to share tabs."
}

main "$@"
