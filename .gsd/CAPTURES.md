# Captures

User-captured thoughts triaged during GSD sessions. Each capture is classified,
confirmed, and recorded here. Token values are **never** persisted in this file
— see secure storage for the original credential material.

---

## CAP-195ec6f4

- **Captured:** 2026-06-04T08:50:30.520Z
- **Text:** Push code to GitHub and Gitee. GitHub account `fengzhi09`; Gitee
  account `liuhailong`. Project is the open-source `mermaid-tui-mcp` library.
  GitHub PAT (`ghp_…REDACTED…`) and Gitee PAT (`…REDACTED…`) were supplied inline
  in the original capture. **Tokens are intentionally not reproduced here** —
  see security note below.
- **Status:** resolved
- **Classification:** defer
- **Resolution:** Defer to a future release/distribution milestone (M002 or
  later) once v0.2.0 is fully validated. The push action is out of scope for
  the current M001 slices (S01–S04 are test/CI/MCP/observability work and
  explicitly do not include a release step). When the release milestone is
  planned, this capture will be re-triaged as a release task with a
  proper checklist: tag v0.2.0, push tagged commit + branch to both remotes,
  attach release notes from CHANGELOG.md, verify README renders on the
  remote. No tokens are written to disk by this executor at any point.
- **Rationale:** The current M001 milestone is a development "收口" milestone
  (test + CI + 7 MCP tools + observability + integration verification). Pushing
  an open-source library to GitHub + Gitee is a **release** activity, not a
  development task. It belongs in a future release/distribution milestone
  where it can be paired with versioning, release notes, and post-publish
  verification. Classifying it as `defer` (not `quick-task`) reflects that it
  is out of scope for S01–S04 and should be re-evaluated at release time.
- **Affected files:** none in repo; `.gsd/CAPTURES.md` updated only.
- **Resolved:** 2026-06-04T09:15:00.000Z
- **Milestone:** M001 (deferred to a future release milestone)
- **Re-confirmed:** 2026-06-04T09:15:00.000Z — re-validated after retry; no
  fields changed, classification still `defer`, no action taken by executor.

---

## Security note — CAP-195ec6f4 (read before re-using these credentials)

The original capture text contained **two live personal access tokens**:

- A GitHub PAT of the form `ghp_…` linked to account `fengzhi09`.
- A Gitee PAT linked to account `liuhailong`.

These values are now exposed in:
1. The user's chat/session transcript.
2. The GSD capture log (`/gsd capture` history).
3. Any backup/snapshot of session state taken before this triage.

**Action required (manual, by the user, immediately):**

1. **Revoke both tokens NOW** at:
   - GitHub: `Settings → Developer settings → Personal access tokens → Delete`
   - Gitee: `设置 → 私人令牌 → 删除`
2. Generate replacement tokens with the **minimum scopes** needed for the
   eventual push (typically `repo` for GitHub; the equivalent for Gitee).
3. Store the replacements in a secret manager (e.g. `git credential helper`,
   OS keychain, or a CI secret store) — **never** paste them into a chat,
   capture, issue, or commit.
4. If these tokens were ever used against a public repository, audit push
   history and the account's security log for unauthorised activity.

This executor will not echo, log, commit, or otherwise re-emit the captured
token values. Future captures should redact credentials before submission
(e.g. "use the GitHub PAT I previously set up in `$GITHUB_TOKEN`").
