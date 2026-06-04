# S04: Integration verification — MCP Inspector + 5-client real smoke

**Researched:** 2026-06-04
**Lane:** research (scout for the planner)
**Status:** Ready to plan

## Summary

S04 is the **user-facing close-out** of M001 v0.2.0. The 7-tool stdio MCP surface, observability, error contract, pluggable storage, and 175/175 tests are all already proven in the S01–S03 baselines. What remains is to **prove the integration layer end-to-end** (real MCP client round-trips) and **ship the user-facing docs** (README + CHANGELOG v0.2.0 + 5 client integration docs).

**Two distinct surfaces:**
1. **MCP Inspector** (`@modelcontextprotocol/inspector@0.21.2` on npm) — the official MCP protocol debugger. Run it in `--cli` mode against `node src/server.mjs`, drive all 7 tools, assert the R020 envelope + 7-tool surface. Proves protocol-level compliance.
2. **Two real LLM clients** (Claude Code 2.1.160 + gsd-pi 1.1.1, both installed) — register the MCP server in their real config files, run a real prompt that triggers `render_mermaid`, capture the response. Proves integration-level (config load + stdio spawn + LLM-driven tool call).

**Three doc updates:**
- README.md (the "One tool" claim is wrong for v0.2.0; needs the 7-tool table)
- CHANGELOG.md (no v0.2.0 entry yet; v0.1.0 entry is current)
- 5 client integration docs in `docs/integration/*.md` (written for v0.1.0's 1-tool surface; need to mention all 7 tools + the new tool-list shape)

**Two validators:**
- Static field check on the 5 integration docs (lock the v0.2.0 surface)
- Re-run all 10 `tests/evals/*.test.mjs` (R027's "all 10 pass" gate)

## Recommendation

Decompose S04 into **5 tasks** (matches the S02/S03 5-task cadence):

- **T01 — Version bump + CHANGELOG v0.2.0** (low risk, mechanical)
- **T02 — README.md rewrite for v0.2.0** (low risk, content-only)
- **T03 — Update 5 client integration docs for v0.2.0 surface** (low risk, mechanical)
- **T04 — MCP Inspector protocol smoke** (medium risk, depends on npm registry access for npx; mostly reuses the S02 stdio-mcp.test.mjs pattern)
- **T05 — Claude Code + gsd-pi real client smoke + R027 gate + doc static check** (HIGHEST RISK — see Risks)

**Total order:** T01 → T02 → T03 (docs cluster) run in parallel as content tasks; T04 (MCP Inspector) is a self-contained integration test; T05 (real clients + R027 gate) depends on T01–T03 being done and on having auth/access for the LLM clients.

**First proof:** T01+T02+T03 in parallel unblock the user-facing delivery; T04 (Inspector) is the first hard-verifiable integration proof; T05 is the last gate (highest risk, runs once everything else is green).

## Implementation Landscape

### What's already in place (do NOT redo)

- **src/server.mjs** — boots stdio MCP, exposes 7 tools via `registerTools`, runs the R020 envelope, has the S03 observability + counter + error contract wired in. `version` constant is `"0.1.0"` (needs bump).
- **src/tools.mjs** — 7 pure handlers + `registerTools(mcp, ctx)` wrapper. The S02 + S03 surface is locked by 25 unit tests + 12 stdio MCP integration tests.
- **src/storage/LocalFsStorage.mjs** — default impl with `getMetadata` + `remove` + `list` + `search` + title-defaulted `put`. MEM024 (id projection on list/search) is fixed. 34 unit tests.
- **src/logger.mjs + src/counters.mjs + src/errors.mjs + src/health-state.mjs + src/port-fallback.mjs** — S03 observability surface.
- **public/view.html** — has `{{TITLE}}` and `{{TITLE_JSON}}` slots (R023 XSS guard locked by 5 render-view-title unit tests).
- **tests/integration/stdio-mcp.test.mjs** (12 cases) — exercises the full 7-tool surface via the JSON-RPC driver in `tests/helpers/server.mjs`. Pattern to mirror for the Inspector test.
- **tests/helpers/server.mjs** — `spawnServer({env, args})` returns `{child, send, close}`. Already used by 12 stdio MCP tests.
- **tests/evals/eval-{01..10}-*.test.mjs** — 10/10 already pass (R027 baseline). Eval-09 was flipped from `it.todo` in S02 T04.

### What needs to change

1. **package.json**: `"version": "0.1.0"` → `"0.2.0"`.
2. **src/server.mjs**: `const VERSION = "0.1.0"` → `"0.2.0"` (line 47-ish).
3. **CHANGELOG.md**: add `## [0.2.0] - 2026-06-04` block above the existing 0.1.0 entry. Document the 7 tools, 175/175 tests, 80.95% coverage baseline, observability (stderr JSON + /health metrics + counters), error contract (-32001..-32009 + -32602), pluggable storage seam.
4. **README.md**:
   - "One tool. `render_mermaid({code})`" → "7 tools" with a table (name, 1-line description, output shape)
   - "Multi-agent" list → expand with a 7-tool surface
   - The current "How the LLM uses it" section still works (the LLM still calls `render_mermaid` first)
   - "Layout" tree needs the new `src/tools.mjs`, `src/logger.mjs`, `src/counters.mjs`, `src/errors.mjs`, `src/health-state.mjs`, `src/port-fallback.mjs`, `src/storage/{Backend,LocalFsStorage}.mjs` files
   - "Limits" section: add the `-32001..-32009 + -32602` error code table or a "Troubleshooting" sub-section
   - "Testing" section: add the 175 test count + the 5-client integration smoke note
5. **docs/integration/{claude-code,gsd-pi,hermes,openclaw,opencode}.md**: each must mention that the server exposes 7 tools (not 1). The "Verifying" sections can keep their current prompt example (it still triggers `render_mermaid`). The `tools.include` / `exclude` example in hermes.md should mention all 7 names (or be revised to "all 7 tools are loaded by default; the include list is for filtering if you want a subset").
6. **NEW: `tests/integration/mcp-inspector.test.mjs`** — drive `npx @modelcontextprotocol/inspector --cli --transport stdio` against `node src/server.mjs` and assert the 7-tool surface + R020 envelope on at least render + pin + list + search.
7. **NEW: `tests/integration/real-client-smoke/`** directory with:
   - `claude-code.mjs` (or `.sh`) — spawn `claude --print --mcp-config '<json>' "Render a flowchart of X"`, capture stdout, assert the response contains ASCII art and a `file://` link. Skip with reason if not authenticated.
   - `gsd-pi.mjs` (or `.sh`) — best-effort: register in `~/.gsd/mcp.json`, run `gsd-pi mcp list` (or equivalent), and either drive a real prompt if gsd-pi supports non-interactive mode, or document the limitation + run a transport-level smoke (spawn the child process gsd-pi would spawn, do the stdio JSON-RPC handshake + tools/list + render_mermaid).
   - `claude-code.log` / `gsd-pi.log` — saved transcripts (committed to the repo as proof artifacts).
8. **NEW: `tests/unit/integration-docs.test.mjs`** (or a small script) — read the 5 `docs/integration/*.md` files, assert each mentions:
   - The `mermaid` server name
   - The v0.2.0 tool set (or a substring like "render_mermaid, pin_mermaid, ...")
   - The correct config file path for that client
   - The openclaw.md one explicitly notes "no native MCP" (workaround path)
9. **NEW: S04 final acceptance report** — when all tasks are done, write `M001-SUMMARY.md` (or update it) noting R027 validation + the 5-client real smoke proof.

## Key Findings

### Current state (verified by running `npm test` in this unit)

- **175/175 tests pass** across 23 test files in ~32 s. The S01 + S02 + S03 baselines are green.
- **10/10 evals pass** — R027's "all 10 real exec" gate is already met. S04's job is to **re-run and report** them, not to write new ones.
- **All 7 tools** are end-to-end exercised via `tests/integration/stdio-mcp.test.mjs` (12 it() blocks: 1 initialize, 1 tools/list asserts 7 tools, 1 render-with-title, 1 search, 1 pin, 1 unpin, 1 list paginates, 1 get full object, 1 delete + ground-truth, 1 search titleMatch, 1 delete 404, 1 oversized -32602).

### Tools available in the env

- **Claude Code 2.1.160** — installed at `/c/Users/ace12/AppData/Roaming/npm/claude`. Supports `claude --print --mcp-config '<json>' "..."` for non-interactive runs (suitable for test smoke). Auth is required (Anthropic API key, OAuth, or apiKeyHelper).
- **gsd-pi 1.1.1** — installed at `/c/Users/ace12/AppData/Roaming/npm/gsd-pi` but the `--help` output shows it is the **installer**, not the runtime. Need to find the runtime entry point in the installer's help / docs, or accept that gsd-pi is interactive-only and the S04 "real call" for gsd-pi is the config + transport-level smoke.
- **@modelcontextprotocol/inspector@0.21.2** — available on npm; runs in `--cli --transport stdio` mode. Slower than driving the JSON-RPC stream directly (spawns a child + Web UI element) but exercises the exact same protocol surface the LLM clients use.
- **MCP SDK** — already a dep (`@modelcontextprotocol/sdk@^1.0.0` → `1.29.0` in lockfile).

### Existing 5-client docs surface (audit)

- `docs/integration/claude-code.md` — JSON config in `.mcp.json` (project) or `~/.claude.json` (user). 1 server: `mermaid`. Path is hardcoded to a real Windows path. Needs to mention the 7 tools and use a `${workspaceFolder}` style variable.
- `docs/integration/gsd-pi.md` — JSON config in `.gsd/mcp.json` / `.mcp.json` / `~/.gsd/mcp.json`. 1 server: `mermaid`. Hardcoded Windows path. Same updates.
- `docs/integration/hermes.md` — YAML config in `~/.hermes/config.yaml`. 1 server: `mermaid`. Has a `tools.include` example filtering to `[render_mermaid]` — needs to mention the 6 new tools OR a "use `[]` to include all 7" note.
- `docs/integration/openclaw.md` — workarounds for no-native-MCP. Workaround 1 (HTTP transport) notes that HTTP mode does not expose a render endpoint; workaround 2 (call `node src/render.mjs` directly) — both still valid for v0.2.0. Needs a note that 6 of the 7 tools are stdio-only and the workaround path is render-only.
- `docs/integration/opencode.md` — JSON config in `opencode.json` / `~/.config/opencode/opencode.json`. 1 server: `mermaid` with `type: "local"`. Same updates as claude-code.

### Bumping the version — test impact audit

The only version-asserting test I found is `tests/integration/stdio-mcp.test.mjs` line ~110: `expect(typeof result.serverInfo.version).toBe("string")` + `expect(result.serverInfo.version.length).toBeGreaterThan(0)`. It does NOT pin to "0.1.0". Safe to bump to "0.2.0".

The `tests/integration/http.test.mjs` doesn't assert on version. `tests/unit/server-helpers.test.mjs` doesn't either. No grep -F "0.1.0" in the test suite. Safe.

## Risks and Constraints

### HIGH RISK: Claude Code auth may not be present in the test env

`claude --print` requires an authenticated session. If the runner has no `ANTHROPIC_API_KEY` env var, no OAuth keychain, and no `apiKeyHelper`, the smoke will exit early with an auth error. **The test must be honest about this**: if auth is missing, mark the test as `it.skip` (or `describe.skip`) with a clear `console.warn("claude smoke skipped: no ANTHROPIC_API_KEY")` and save the stderr transcript to a log file as proof of the attempt. The local-dev path is: `ANTHROPIC_API_KEY=... npm test` will run the smoke for real.

The smoke does NOT need to be a CI gate. It is a "real client was tested" proof artifact. Suggested location: `tests/integration/real-client-smoke/claude-code.log` (committed to the repo) so the next developer can see the transcript.

### HIGH RISK: gsd-pi is interactive-only

The installed `gsd-pi` 1.1.1 binary is the **installer**, not the runtime (per the `--help` output). There is no obvious `gsd-pi --prompt "..."` mode. The S04 "real call" for gsd-pi has two honest paths:

(a) **Transport-level smoke (recommended)**: write a test that registers the MCP server in a temp `~/.gsd/mcp.json` (or just spawns the same `node src/server.mjs` child gsd-pi would spawn), does the JSON-RPC initialize + tools/list + tools/call (render_mermaid) handshake, and saves the response as a `gsd-pi-transport-smoke.log` artifact. The "real integration" is at the transport layer; gsd-pi would just be a UI wrapper on top. This is the honest level of testing we can do in a non-interactive env.

(b) **PTY-driven smoke (heavy)**: spawn gsd-pi in a PTY, pipe a prompt, capture the response. This is what real-world "drive an interactive shell from a test" looks like (e.g., `node-pty` or `expect`). High implementation cost, low value for M001.

**Recommendation: go with (a)** and document the gsd-pi limitation in the log file + the S04 SUMMARY.

### MEDIUM RISK: MCP Inspector npx cost

`npx @modelcontextprotocol/inspector` will download the package on first run (~80MB, ~30s). In CI with `npm ci` cache, it's fast. In a clean env, it adds 30s to first test. Either:
- (a) Add `@modelcontextprotocol/inspector` to devDependencies so it's pre-installed, OR
- (b) Accept the npx cost (one-time per CI machine, then cached).

**Recommendation: (b)** — don't pollute devDependencies with a test-only dep.

### MEDIUM RISK: `claude --print` spawn cost + flakiness

`claude --print` cold-starts a full LLM agent loop. First call: 10–30 s; later calls: 2–10 s. The smoke may flake if Anthropic has an outage. **Mark the test as best-effort**: if it fails, save the transcript + the exit code, but don't fail the test suite. Use `it.skip` semantics on a per-assertion basis (one assertion failure → mark the rest as "inconclusive" but don't fail).

### LOW RISK: 5-client doc drift

The 5 integration docs are written for v0.1.0. The updates are mechanical: "the server now exposes 7 tools; the example prompt still triggers `render_mermaid` first." No code change. ~30 minutes of editing total.

### LOW RISK: README "One tool" claim is wrong

Lines 11, 17, 19 of README.md say "One tool." and "`render_mermaid({code})` returns `{id, ascii, fileLink, httpLink}`. No tool explosion." This is the v0.1.0 message. v0.2.0 has 7 tools. The change is content-only.

### LOW RISK: CHANGELOG is missing the v0.2.0 entry

Just above the existing 0.1.0 entry. Mechanical.

## Open Questions

- **Q1 (Claude Code auth):** Should we add the Claude Code smoke to the CI suite, or keep it as a local-only "real client was tested" proof artifact?
  - **Recommendation:** keep it local-only. CI has no auth; the test would always skip. The transcript file is the proof.

- **Q2 (gsd-pi interactive):** Is there a way to drive gsd-pi non-interactively that I haven't found?
  - **Recommendation:** if the user knows one, surface it; otherwise use the transport-level smoke + a written limitation in the log.

- **Q3 (MCP Inspector in CI):** Should the MCP Inspector test be in `npm test` or in a separate `npm run test:integration:smoke` script?
  - **Recommendation:** in `npm test` (so it's part of the S04 acceptance gate), with a `test:integration:smoke` script as a faster opt-in. The Inspector test should be its own `describe` block in `tests/integration/mcp-inspector.test.mjs` so it can be excluded with `vitest run --exclude` if needed.

- **Q4 (Doc static check):** Should the doc-static-check be a vitest test, a script, or a CI lint step?
  - **Recommendation:** vitest unit test in `tests/unit/integration-docs.test.mjs` — matches the existing test layout, runs in `npm test`, fails loudly on doc drift.

- **Q5 (Version bump side effects):** Does any test, script, or doc assert a specific version string?
  - **Recommendation:** confirmed by `grep -rn "0.1.0" tests/` — no test pins to a specific version. Safe to bump.

## Verification (for the planner to use in the task plans)

### T01 verification
- `grep "\"version\"" package.json` → `"0.2.0"`
- `grep "VERSION" src/server.mjs` → `const VERSION = "0.2.0";`
- `head -50 CHANGELOG.md` shows `## [0.2.0] - 2026-06-04` block above `## [0.1.0]`
- `npm test` still green (175/175) — no test pins a specific version

### T02 verification
- README.md mentions "7 tools" (or "seven tools")
- README.md has a 7-tool table with columns: name, description, output
- README.md "Layout" section lists the new src/ files
- `grep -c "render_mermaid" README.md` ≥ 1
- `grep -c "7 tools" README.md` ≥ 1

### T03 verification
- Each of the 5 `docs/integration/*.md` mentions all 7 tool names (or a clear "7 tools: …" enumeration)
- `docs/integration/openclaw.md` still has the "no native MCP" note
- The `tools.include` example in `hermes.md` reflects the 7-tool surface (either include all, or list the 7 names as comments)

### T04 verification (MCP Inspector)
- New file: `tests/integration/mcp-inspector.test.mjs`
- `npx @modelcontextprotocol/inspector --cli --transport stdio` is spawned as a child with `node src/server.mjs` as the server
- At least 5 it() blocks: initialize, tools/list (asserts 7 tools), render_mermaid, pin_mermaid, search_diagrams
- `npm test` still green (175 + new = at least 180)

### T05 verification (real clients + R027 + doc check)
- New file: `tests/integration/real-client-smoke/{claude-code,gsd-pi}.mjs` (or `.sh`) with a saved `.log` transcript
- New file: `tests/unit/integration-docs.test.mjs` — reads 5 docs, asserts key substrings
- `npm test` exits 0 (or with auth-skip warning for Claude Code)
- `npx vitest run tests/evals/` exits 0 — 10/10 evals pass (R027)
- The S04 MILESTONE-SUMMARY references the 5-client smoke proof files
