#!/usr/bin/env bash
# Build the personal macOS app; installation remains a separate action.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "This launcher builds the personal macOS app." >&2
  exit 1
fi
fork_arch="$(uname -m)"
if [[ "$fork_arch" == x86_64 ]]; then fork_arch=x64; fi
fork_base_version="$(vp env exec --node 24 -- node -p "JSON.parse(require('fs').readFileSync('apps/server/package.json')).version")"
fork_version="${1:-${fork_base_version}-itamar.$(date +%Y%m%d).$(date +%H%M%S)}"
if [[ "$fork_arch" == arm64 ]] && ! command -v cargo >/dev/null &&
  [[ -x native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor ]]; then
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true
fi
exec env -u ELECTRON_RUN_AS_NODE vp env exec --node 24 -- node scripts/build-desktop-artifact.ts \
  --platform mac --target zip --arch "$fork_arch" --build-version "$fork_version" \
  --output-dir release/itamar
