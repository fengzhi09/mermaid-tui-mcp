# S04: Integration verification - MCP Inspector and 5-client real smoke

**Goal:** Close M001 v0.2.0 with end-to-end integration proof: bump version to 0.2.0, refresh user-facing docs (README + CHANGELOG + 5 client integration docs), add MCP Inspector protocol smoke test, and add Claude Code + gsd-pi real-client smoke (transport-level for gsd-pi) + the R027 10/10 evals re-validate gate + doc static check.
**Demo:** MCP Inspector 跑全 7 工具所有契约满足;Claude Code 真启动与真调一次 render_mermaid 拿到 ASCII 与链接;gsd-pi 真启动与真调一次 render_mermaid 拿到 ASCII 与链接;Hermes 与 opencode 与 OpenClaw 集成 doc 字段静态检查;CHANGELOG 写 v0.2.0(列出 7 工具与计数器与测试基线);README 更新(7 工具表与快速开始与故障排查)

## Must-Haves

- S04 is complete when ALL of the following are true:
- 1. `package.json` `version` is `"0.2.0"` and `src/server.mjs` `VERSION` is `"0.2.0"`
- 2. `CHANGELOG.md` has a `## [0.2.0] - 2026-06-04` block above the v0.1.0 entry, covering the 7-tool surface, 175/175 tests, 80.95% coverage, S03 observability (stderr JSON + /health metrics + counters), the -32001..-32009 + -32602 error code set, 3 retry paths (R015/R017/R018), HTTP port fallback (R016), and the pluggable storage seam
- 3. `README.md` mentions "7 tools" and contains a 7-tool table; the v0.1.0 "One tool" framing is removed; the Layout section lists all 9 new S02 + S03 source files; a Troubleshooting section references all 10 error codes
- 4. All 5 `docs/integration/*.md` mention the v0.2.0 7-tool surface; `hermes.md` `tools.include` example reflects the 7 tools; `openclaw.md` keeps the "no native MCP" note plus the new stdio-only callout
- 5. `tests/integration/mcp-inspector.test.mjs` exists with at least 5 it() blocks; `npm test` is green (175 + new >= 180); the new test asserts tools/list returns 7 tools and verifies R020 envelope on at least render_mermaid + pin_mermaid
- 6. `tests/integration/real-client-smoke/claude-code.{mjs,log}` and `gsd-pi.{mjs,log}` exist; `tests/unit/integration-docs.test.mjs` is green (5 docs each contain `mermaid` + at least 4 of the 7 tool names; openclaw.md exempted for tool-name count)
- 7. `npx vitest run tests/evals/` is 10/10 green (R027)
- 8. S04 MILESTONE-SUMMARY references all 5 client smoke proof files and all 5 docs files; the gsd-pi interactive-only limitation is documented in the gsd-pi log header

## Proof Level

- This slice proves: Integration + UAT — T04 (MCP Inspector) is the protocol-level proof; T05 (Claude Code + gsd-pi real-client smoke + doc static check + R027 re-validate) is the integration-level proof; T01–T03 (version + docs) are the user-facing close-out.

## Integration Closure

Upstream consumed from S01–S03: 175/175 vitest test baseline (23 files, ~30s); 7 stdio MCP tools with R020 envelopes via `tests/helpers/server.mjs` JSON-RPC driver; StorageBackend interface + LocalFsStorage default impl; S03 observability surface (src/logger.mjs, src/counters.mjs, src/errors.mjs, src/health-state.mjs, src/port-fallback.mjs); MEM024 closure (list/search items carry id) visible at the Inspector level.

New wiring introduced in S04: 5 client integration docs updated for v0.2.0 surface; README.md rewritten for 7-tool surface + Troubleshooting section; CHANGELOG.md v0.2.0 entry; version constants bumped in package.json + src/server.mjs; new `tests/integration/mcp-inspector.test.mjs` (5+ it blocks: initialize, tools/list 7-tool assertion, render_mermaid R020 envelope, pin_mermaid R020 envelope, search_diagrams with id projection); new `tests/integration/real-client-smoke/` directory with Claude Code + gsd-pi transport-level smoke scripts and durable .log proof artifacts; new `tests/unit/integration-docs.test.mjs` static check; R027 evals re-validation gate.

T05 explicitly depends on T01–T03 (docs) and T04 (Inspector surface) being green before declaring S04 done. The R027 evals re-run is the final acceptance gate. S04 close-out produces `M001-SUMMARY.md` (or updates it) noting all 5 client smoke artifacts, the gsd-pi interactive-only limitation, and the S03 observability surface that the real clients now reach.

## Verification

- S04 closes the observability loop: README + 5 client integration docs now reference the stderr JSON / /health metrics / counters / error code surface from S03 in user-facing prose. The 5-client smoke proof artifacts (claude-code.log, gsd-pi.log, MCP Inspector test output) become durable proof that the observability surface is reachable from real clients. No new observability surface is added in S04 — only consumed and documented for end users.

## Tasks

- [x] **T01: Version bump + CHANGELOG v0.2.0** `est:15m`
  Mechanical version bump across 3 files plus a CHANGELOG entry that documents the v0.2.0 surface for end users. No test pins to "0.1.0" (audited via grep -F "0.1.0" tests/ in RESEARCH), so the bump is safe.
  - Files: `package.json`, `src/server.mjs`, `CHANGELOG.md`
  - Verify: Run all of:
- `grep '\"version\"' package.json` → contains `"0.2.0"`
- `grep -n 'VERSION = ' src/server.mjs` → contains `"0.2.0"`
- `head -50 CHANGELOG.md` shows `## [0.2.0] - 2026-06-04` above `## [0.1.0]`
- `npm test` exits 0; no test fails due to version string pinning

- [x] **T02: Rewrite README.md for v0.2.0 7-tool surface** `est:30m`
  README.md still describes v0.1.0 ("One tool. render_mermaid({code}) returns {id, ascii, fileLink, httpLink}"). v0.2.0 has 7 tools + the S03 observability surface. This task updates the user-facing README to match reality. Content-only — no code change.
  - Files: `README.md`
  - Verify: Run all of:
- `grep -c '7 tools' README.md` >= 1
- `grep -c 'render_mermaid' README.md` >= 1
- 7-row tool table present (verify by counting rows in any markdown table block; or grep for all 7 tool names)
- "Layout" section references tools.mjs, logger.mjs, counters.mjs, errors.mjs, health-state.mjs, port-fallback.mjs
- "Troubleshooting" or "Limits" section mentions -32001..-32009 + -32602

- [x] **T03: Update 5 client integration docs for v0.2.0 surface** `est:30m`
  All 5 `docs/integration/*.md` files were written for v0.1.0's 1-tool surface. They need to mention the v0.2.0 7-tool surface. Mechanical edit, no code change.
  - Files: `docs/integration/claude-code.md`, `docs/integration/gsd-pi.md`, `docs/integration/hermes.md`, `docs/integration/openclaw.md`, `docs/integration/opencode.md`
  - Verify: Run all of:
- For each of the 5 files: file contains all 7 tool names (or an explicit "7 tools: render_mermaid, pin_mermaid, ..." enumeration)
- `openclaw.md` still contains the "no native MCP" workaround note
- `hermes.md` `tools.include` example is `[]` (for all 7) or a commented list of all 7 names
- The `mermaid` server config blocks in claude-code.md / gsd-pi.md / opencode.md are structurally unchanged (same JSON keys, same path)

- [x] **T04: Add MCP Inspector protocol smoke test** `est:1h`
  Create `tests/integration/mcp-inspector.test.mjs` that drives the official `@modelcontextprotocol/inspector` package in CLI mode against `node src/server.mjs`. This proves protocol-level compliance (R020 envelope + 7-tool surface) through a real client implementation, not just our own test driver.
  - Files: `tests/integration/mcp-inspector.test.mjs`
  - Verify: Run all of:
- `ls tests/integration/mcp-inspector.test.mjs` → file exists, size > 1KB
- `npm test` exits 0 (175 + new >= 180 tests pass, with the new file included)
- Running the new test individually (`npx vitest run tests/integration/mcp-inspector.test.mjs`) asserts tools/list returns 7 tools
- Running the new test individually verifies R020 envelope on render_mermaid AND pin_mermaid
- If npx is unavailable, the test skips with a clear warning, not a failure

- [x] **T05: Real client smoke + R027 re-validate + doc static check** `est:2h`
  Three deliverables: (1) Claude Code real-client smoke, (2) gsd-pi transport-level smoke, (3) doc static check test, (4) R027 10/10 evals re-validate gate.
  - Files: `tests/integration/real-client-smoke/claude-code.mjs`, `tests/integration/real-client-smoke/claude-code.log`, `tests/integration/real-client-smoke/gsd-pi.mjs`, `tests/integration/real-client-smoke/gsd-pi.log`, `tests/unit/integration-docs.test.mjs`
  - Verify: Run all of:
- `ls tests/integration/real-client-smoke/` shows 4 files (claude-code.mjs, claude-code.log, gsd-pi.mjs, gsd-pi.log)
- `ls tests/unit/integration-docs.test.mjs` exists
- `npm test` exits 0 (auth-skip warning is acceptable; no failure)
- `npx vitest run tests/evals/` exits 0 — 10/10 evals pass (R027)
- `claude-code.log` contains valid JSON-RPC responses for at least the `tools/list` call (or the auth-skip warning header)
- `gsd-pi.log` contains valid JSON-RPC responses for the transport-level smoke (initialize + tools/list + tools/call)

## Files Likely Touched

- package.json
- src/server.mjs
- CHANGELOG.md
- README.md
- docs/integration/claude-code.md
- docs/integration/gsd-pi.md
- docs/integration/hermes.md
- docs/integration/openclaw.md
- docs/integration/opencode.md
- tests/integration/mcp-inspector.test.mjs
- tests/integration/real-client-smoke/claude-code.mjs
- tests/integration/real-client-smoke/claude-code.log
- tests/integration/real-client-smoke/gsd-pi.mjs
- tests/integration/real-client-smoke/gsd-pi.log
- tests/unit/integration-docs.test.mjs
