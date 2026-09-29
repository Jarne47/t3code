#!/usr/bin/env bash
# Keep the fork's runtime data separate from the installed T3 application.
set -euo pipefail
cd "$(dirname "$0")/.."
exec vp env exec --node 24 -- vp run dev --home-dir "$PWD/.t3" "$@"
