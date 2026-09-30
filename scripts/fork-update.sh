#!/usr/bin/env bash
# Bring upstream changes into the current fork branch, then verify and rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your work before updating." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != itamar/* ]]; then
  echo "Switch to your itamar/* customization branch before updating." >&2
  exit 1
fi
upstream_ref="${1:-main}"
git check-ref-format --allow-onelevel "$upstream_ref" >/dev/null
# Weekly maintenance pushes verified merges without changing this checkout.
fork_branch="$(git branch --show-current)"
git fetch personal "$fork_branch"
git merge --ff-only FETCH_HEAD
git fetch upstream "$upstream_ref"
if ! git merge --no-edit FETCH_HEAD; then
  echo "Resolve the merge conflicts and run scripts/fork-check.sh, or use git merge --abort." >&2
  exit 1
fi
vp env exec --node 24 -- vp install --frozen-lockfile
./scripts/fork-check.sh
vp env exec --node 24 -- vp run --filter @t3tools/web build
echo "Fork updated and web client rebuilt. Nothing was installed or deployed."
