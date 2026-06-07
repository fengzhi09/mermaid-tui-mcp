#!/usr/bin/env bash
# publish.sh — push this repo to Gitee (fengzhi09/mermaid-tui-mcp) and GitHub
# (fengzhi09/mermaid-tui-mcp).
#
# Two transport modes:
#
#   1. HTTPS + personal access token (default, legacy):
#        Tokens are read from environment variables and are NEVER written to
#        disk or committed. After the push, remote URLs are restored to plain
#        https:// so that `git remote -v` does not leak secrets.
#
#   2. SSH (--ssh flag, recommended when the local user has SSH keys registered
#      to the target Gitee/GitHub accounts):
#        Uses the existing remote URL verbatim (must already be git@...).
#        No tokens involved. SSH key trust is established out of band; this
#        script does not run ssh-add and does not touch ~/.ssh/.
#
# Prereqs (HTTPS mode):
#   1. Empty repos `fengzhi09/mermaid-tui-mcp` on Gitee and GitHub
#      already exist (create via the web UI if you have not yet).
#   2. Your shell has GITEE_TOKEN and/or GITHUB_TOKEN set.
#
# Prereqs (SSH mode):
#   1. Same as above.
#   2. The local `gitee` and/or `github` git remotes point at the
#      `git@<host>:fengzhi09/mermaid-tui-mcp.git` form, NOT `https://...`.
#      (Set this with `git remote set-url <name> git@<host>:fengzhi09/mermaid-tui-mcp.git`.)
#   3. Your SSH key (e.g. ~/.ssh/id_rsa.pub) is registered to the Gitee/GitHub
#      account that owns the target repo.
#
# Usage:
#   GITEE_TOKEN=xxx                       bash scripts/publish.sh --only gitee
#   GITHUB_TOKEN=yyy                      bash scripts/publish.sh --only github
#   GITEE_TOKEN=xxx GITHUB_TOKEN=yyy      bash scripts/publish.sh
#   bash scripts/publish.sh --ssh --only gitee    # SSH mode (no token needed)
#   bash scripts/publish.sh --ssh                 # SSH mode, push both
#   bash scripts/publish.sh --tag v0.1.0          # also create + push a tag
#
# To get a Gitee token:  https://gitee.com/profile/personal_access_tokens
# To get a GitHub token: https://github.com/settings/tokens (classic, `repo` scope)

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

BRANCH="${BRANCH:-main}"
TAG=""
ONLY=""
SSH_ONLY=false

GITEE_REPO_URL="https://gitee.com/fengzhi09/mermaid-tui-mcp.git"
GITEE_SSH_URL="git@gitee.com:fengzhi09/mermaid-tui-mcp.git"
GITHUB_REPO_URL="https://github.com/fengzhi09/mermaid-tui-mcp.git"
GITHUB_SSH_URL="git@github.com:fengzhi09/mermaid-tui-mcp.git"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    --ssh) SSH_ONLY=true; shift ;;
    --https) SSH_ONLY=false; shift ;;
    --help|-h)
      sed -n '2,50p' "$0"; exit 0 ;;
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

# --- 3a. push helper (SSH): no token, uses the remote URL as configured ---
push_ssh() {
  local name="$1"
  local label="$2"

  if ! git remote get-url "$name" >/dev/null 2>&1; then
    echo "[publish] SKIP $label: remote '$name' is not configured" >&2
    return 0
  fi
  local url
  url="$(git remote get-url "$name")"
  if [[ "$url" != git@* ]]; then
    echo "[publish] SKIP $label: remote '$name' is $url (not SSH; use --https or set-url to git@...)" >&2
    return 0
  fi

  echo "[publish] pushing $BRANCH to $name via SSH ($url)"
  git push -u "$name" "$BRANCH"
  echo "[publish] $name push done (SSH, no token used)"
}

# --- 3b. push helper (HTTPS): temporarily rewrite remote URL with token, push, restore ---
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
if [[ "$SSH_ONLY" == true ]]; then
  if [[ "$ONLY" != "github" ]]; then
    push_ssh "gitee" "Gitee"
  fi
  if [[ "$ONLY" != "gitee" ]]; then
    push_ssh "github" "GitHub"
  fi
else
  if [[ "$ONLY" != "github" ]]; then
    push_with_token "gitee" "$GITEE_REPO_URL" "${GITEE_TOKEN:-}" "Gitee"
  fi
  if [[ "$ONLY" != "gitee" ]]; then
    push_with_token "github" "$GITHUB_REPO_URL" "${GITHUB_TOKEN:-}" "GitHub"
  fi
fi

# --- 5. optional tag ---
if [[ -n "$TAG" ]]; then
  echo "[publish] creating tag $TAG"
  git tag -a "$TAG" -m "Release $TAG"
  for remote in gitee github; do
    if [[ "$ONLY" == "gitee" && "$remote" != "gitee" ]]; then continue; fi
    if [[ "$ONLY" == "github" && "$remote" != "github" ]]; then continue; fi
    if ! git remote get-url "$remote" >/dev/null 2>&1; then continue; fi
    if [[ "$SSH_ONLY" == true ]]; then
      local_url="$(git remote get-url "$remote")"
      if [[ "$local_url" != git@* ]]; then
        echo "[publish] SKIP $remote tag push: remote is $local_url, not SSH" >&2
        continue
      fi
      git push "$remote" "$TAG"
    else
      local_token_var="${remote^^}_TOKEN"
      local_token="${!local_token_var:-}"
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
echo "  Gitee:  $(git remote get-url gitee 2>/dev/null || echo 'not configured')"
echo "  GitHub: $(git remote get-url github 2>/dev/null || echo 'not configured')"
