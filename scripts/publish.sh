#!/usr/bin/env bash
# publish.sh — push this repo to Gitee (gitee.com/lhl/mermaid-tui-mcp).
#
# Idempotent. Safe to re-run. Assumes:
#   1. git is configured with your Gitee SSH key (git@gitee.com).
#   2. The repo `lhl/mermaid-tui-mcp` already exists on Gitee (empty).
#      Create it at https://gitee.com/new if you have not yet.
#
# Usage:
#   bash scripts/publish.sh                 # push to main
#   bash scripts/publish.sh --tag v0.1.0    # create a tag and push it

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

REMOTE="${GITEE_REMOTE:-gitee}"
REPO_URL="${GITEE_REPO_URL:-git@gitee.com:lhl/mermaid-tui-mcp.git}"
BRANCH="${BRANCH:-main}"
TAG=""

for arg in "$@"; do
  case "$arg" in
    --tag) shift; TAG="${1:-}" ;;
    --remote) shift; REMOTE="${1:-gitee}" ;;
    --branch) shift; BRANCH="${1:-main}" ;;
    --help|-h)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# --- 1. safety: refuse to publish with uncommitted changes ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree has uncommitted changes." >&2
  git status --short
  exit 1
fi

# --- 2. init if needed ---
if [[ ! -d "$DIR/.git" ]]; then
  echo "[publish] git init"
  git init -q -b "$BRANCH"
  git config user.email  "${GIT_AUTHOR_EMAIL:-lhl@users.noreply.gitee.com}"
  git config user.name   "${GIT_AUTHOR_NAME:-lhl}"
  git add -A
  git commit -q -m "feat: initial release of mermaid-tui-mcp v0.1.0"
  echo "[publish] initial commit created"
fi

# --- 3. ensure remote ---
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "[publish] adding remote $REMOTE -> $REPO_URL"
  git remote add "$REMOTE" "$REPO_URL"
fi
ACTUAL_URL="$(git remote get-url "$REMOTE")"
if [[ "$ACTUAL_URL" != "$REPO_URL" ]]; then
  echo "[publish] WARNING: remote $REMOTE is $ACTUAL_URL, expected $REPO_URL" >&2
fi

# --- 4. push branch ---
echo "[publish] pushing $BRANCH to $REMOTE"
git push -u "$REMOTE" "$BRANCH"

# --- 5. optional tag ---
if [[ -n "$TAG" ]]; then
  echo "[publish] creating tag $TAG"
  git tag -a "$TAG" -m "Release $TAG"
  git push "$REMOTE" "$TAG"
fi

echo "[publish] done. Visit: https://gitee.com/lhl/mermaid-tui-mcp"
