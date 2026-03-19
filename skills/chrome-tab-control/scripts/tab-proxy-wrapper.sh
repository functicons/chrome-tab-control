#!/usr/bin/env bash
# Wrapper to launch tab-proxy.mjs with the correct Node.js.
# Chrome native messaging doesn't inherit the user's shell PATH,
# so nvm/fnm/volta-managed Node.js won't be found via #!/usr/bin/env node.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Try common Node.js locations
find_nvm_node() {
  local versions_dir="$HOME/.nvm/versions/node"
  [ -d "${versions_dir}" ] || return 1
  local latest
  latest="$(ls "${versions_dir}" 2>/dev/null | sort -V | tail -1)"
  [ -n "${latest}" ] && [ -x "${versions_dir}/${latest}/bin/node" ] && echo "${versions_dir}/${latest}/bin/node"
}

NODE=""
if NODE="$(find_nvm_node)" && [ -n "${NODE}" ]; then
  :
elif [ -x "$HOME/.volta/bin/node" ]; then
  NODE="$HOME/.volta/bin/node"
elif [ -x "$HOME/.local/share/fnm/node-versions" ]; then
  # fnm stores versions differently; try its shim
  NODE="$HOME/.local/share/fnm/aliases/default/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
elif [ -x "/usr/local/bin/node" ]; then
  NODE="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE="/opt/homebrew/bin/node"
else
  echo '{"error":"Node.js not found"}' >&2
  exit 1
fi

exec "${NODE}" "${SCRIPT_DIR}/tab-proxy.mjs"
