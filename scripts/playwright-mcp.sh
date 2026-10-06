#!/bin/sh
set -eu

# Finder-launched apps may not inherit Homebrew's executable directories.
PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
export PATH

if ! PLAYWRIGHT_MCP_EXTENSION_TOKEN="$(security find-generic-password \
  -s "copilot-playwright-mcp" \
  -a "PLAYWRIGHT_MCP_EXTENSION_TOKEN" \
  -w 2>/dev/null)"; then
  printf '%s\n' 'Playwright token unavailable. Unlock Keychain or add the extension token before connecting.' >&2
  exit 1
fi

if [ -z "$PLAYWRIGHT_MCP_EXTENSION_TOKEN" ]; then
  printf '%s\n' 'Playwright token is empty. Update the Keychain entry before connecting.' >&2
  exit 1
fi
export PLAYWRIGHT_MCP_EXTENSION_TOKEN

if ! NPX="$(command -v npx)"; then
  printf '%s\n' 'Node.js with npx is required for Playwright MCP.' >&2
  exit 1
fi

exec "$NPX" -y @playwright/mcp@latest --extension
