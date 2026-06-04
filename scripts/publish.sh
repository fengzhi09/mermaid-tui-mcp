#!/usr/bin/env bash
# publish.sh — push this repo to Gitee (liuhailong/mermaid-tui-mcp) and GitHub
# (fengzhi09/mermaid-tui-mcp).
#
# Tokens are read from environment variables and are NEVER written to disk or
# committed. After the push, remote URLs are restored to plain https:// so that
# `git remote -v` does not leak secrets.
#
# Prereqs:
#   1. Empty repos `liuhailong/mermaid-tui-mcp` on Gitee and
#      `fengzhi09/mermaid-tui-mcp` on GitHub already exist (create via the
#      web UI if you have not yet).
#   2. Your shell has GITEE_TOKEN and/or GITHUB_TOKEN set.
#
# Usage:
#   GITEE_TOKEN=xxx                       bash scripts/publish.sh --only gitee
#   GITHUB_TOKEN=yyy                      bash scripts/publish.sh --only github
#   GITEE_TOKEN=xxx GITHUB_TOKEN=yyy      bash scripts/publish.sh
#   bash scripts/publish.sh --tag v0.1.0      # also create + push a tag
#
# To get a Gitee token:  https://gitee.com/profile/personal_access_tokens
# To get a GitHub token: https://github.com/settings/tokens (classic, `repo` scope)

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

BRANCH="${BRANCH:-main}"
TAG=""
ONLY=""

GITEE_REPO_URL="https://gitee.com/liuhailong/mermaid-tui-mcp.git"
GITHUB_REPO_URL="https://github.com/fengzhi09/mermaid-tui-mcp.git"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$ONLY" && "$ONLY" != "gitee" && "$ONLY" != "github" ]]; then
  echo "ERROR: --only must be 'gitee' or 'github' (got '$ONLY')" >&2
  exit 2
fi

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
  git config user.name   "${GIT_AUTHOR_NAME:-liuhailong}"
  git add -A
  git commit -q -m "feat: initial release of mermaid-tui-mcp v0.1.0"
  echo "[publish] initial commit created"
fi

# --- 3. push helper: temporarily rewrite remote URL with token, push, restore ---
push_with_token() {
  local name="$1"
  local base_url="$2"
  local token="$3"
  local label="$4"

  if [[ -z "$token" ]]; then
    echo "[publish] SKIP $label: $name token is empty (set ${name^^}_TOKEN)" >&2
    return 0
  fi

  if ! git remote get-url "$name" >/dev/null 2>&1; then
    echo "[publish] adding remote $name -> $base_url"
    git remote add "$name" "$base_url"
  fi
  local plain_url
  plain_url="$(git remote get-url "$name")"
  if [[ "$plain_url" != "$base_url" ]]; then
    echo "[publish] WARNING: remote $name is $plain_url, expected $base_url" >&2
  fi

  # Inject token into the URL just for this push.
  local with_token
  with_token="$(echo "$base_url" | sed -E "s#https://#https://x-access-token:${token}@#")"
  echo "[publish] pushing $BRANCH to $name"
  git push -u "$with_token" "$BRANCH"

  # Restore the plain URL so secrets don't linger in .git/config.
  git remote set-url "$name" "$base_url"
  echo "[publish] $name push done; remote URL restored to plain https"
}

# --- 4. push ---
if [[ "$ONLY" != "github" ]]; then
  push_with_token "gitee" "$GITEE_REPO_URL" "${GITEE_TOKEN:-}" "Gitee"
fi
if [[ "$ONLY" != "gitee" ]]; then
  push_with_token "github" "$GITHUB_REPO_URL" "${GITHUB_TOKEN:-}" "GitHub"
fi

# --- 5. optional tag ---
if [[ -n "$TAG" ]]; then
  echo "[publish] creating tag $TAG"
  git tag -a "$TAG" -m "Release $TAG"
  for remote in gitee github; do
    if git remote get-url "$remote" >/dev/null 2>&1; then
      local_token_var="${remote^^}_TOKEN"
      local_token="${!local_token_var:-}"
      local_url
      local_url="$(git remote get-url "$remote")"
      if [[ -n "$local_token" ]]; then
        local with_token
        with_token="$(echo "$local_url" | sed -E "s#https://#https://x-access-token:${local_token}@#")"
        git push "$with_token" "$TAG"
      else
        echo "[publish] SKIP $remote tag push: ${local_token_var} empty" >&2
      fi
    fi
  done
fi

echo "[publish] done."
echo "  Gitee:  https://gitee.com/liuhailong/mermaid-tui-mcp"
echo "  GitHub: https://github.com/fengzhi09/mermaid-tui-mcp"
