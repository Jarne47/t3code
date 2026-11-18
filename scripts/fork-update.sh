#!/usr/bin/env bash
# Bring upstream changes into the current fork branch, then verify and rebuild.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash your work before updating." >&2
  exit 1
fi
if [[ "$(git branch --show-current)" != main && "$(git branch --show-current)" != itamar/* ]]; then
  echo "Switch to main or an itamar/* customization branch before updating." >&2
  exit 1
fi
# Default to the newest upstream nightly: a commit its release workflow already built and packaged.
if [[ $# -eq 0 ]]; then
  git fetch --no-tags official '+refs/tags/v*:refs/tags/v*'
  upstream_ref="$(git tag --list 'v*-nightly.*' --sort=-v:refname | head -n 1)"
  [[ -n "$upstream_ref" ]] || { echo "No upstream nightly tags found." >&2; exit 1; }
else
  upstream_ref="$1"
fi
git check-ref-format --allow-onelevel "$upstream_ref" >/dev/null
# Weekly maintenance pushes verified merges without changing this checkout.
fork_branch="$(git branch --show-current)"
git fetch origin "$fork_branch"
git merge --ff-only FETCH_HEAD
if git rev-parse -q --verify "refs/tags/$upstream_ref" >/dev/null; then
  upstream_commit="$upstream_ref^{commit}"
else
  git fetch official "$upstream_ref"
  upstream_commit=FETCH_HEAD
fi
echo "Merging $upstream_ref"
if ! git merge --no-edit "$upstream_commit"; then
  echo "Resolve the merge conflicts and run scripts/fork-check.sh, or use git merge --abort." >&2
  exit 1
fi
vp env exec --node 24 -- vp install --frozen-lockfile
./scripts/fork-check.sh
vp env exec --node 24 -- vp run --filter @t3tools/web build
echo "Fork updated and web client rebuilt. Nothing was installed or deployed."
