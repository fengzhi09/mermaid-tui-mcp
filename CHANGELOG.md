# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **npm package distribution: `mermaid-tui-mcp` is now installable via `npm install mermaid-tui-mcp` or `npx -y mermaid-tui-mcp`.** The `package.json` `bin` field exposes the same `src/server.mjs` entrypoint as the `mermaid-tui-mcp` command, so `npx -y mermaid-tui-mcp` (with `MERMAID_RENDERER_HTTP=1` for the optional HTTP mode) starts the server without any local clone. `package.json` gained the npm metadata required for a public publish: `keywords`, `author`, `license: MIT`, `homepage`, `repository`, `bugs`, `publishConfig.access: public`, and a `files` allowlist (`src/`, `bin/`, `public/`, `README.md`, `LICENSE`, `CHANGELOG.md`) so the npm tarball stays small and excludes `tests/`, `scripts/`, `docs/`, `.github/`, `coverage/`, and `data/`. `src/server.mjs` now has a `#!/usr/bin/env node` shebang so the bin entry is directly executable on every platform.

### Changed

- **All 5 client integration docs (`docs/integration/{claude-code,gsd-pi,opencode,hermes,openclaw}.md`), the root `README.md` Quick Start, the root `.mcp.json`, and the `package.json` `mcpServers` reference block were migrated from hard-coded absolute paths (`C:/Users/.../src/server.mjs`, `${workspaceFolder}/src/server.mjs`) to the `npx -y mermaid-tui-mcp` form.** No local clone, no per-platform path quoting, no `cp -r extensions/...` dance for the common case. The `bin` name was renamed from `gsd-mermaid-renderer` to `mermaid-tui-mcp` to match the package name (so `npx mermaid-tui-mcp` resolves to the same script). The `mermaid-direct` gsd-pi extension install flow now goes through `npm install -g mermaid-tui-mcp` first, then `cp -r "$(npm root -g)/mermaid-tui-mcp/extensions/gsd-pi-mermaid" ~/.pi/agent/extensions/mermaid-direct` and `export MERMAID_SERVER_PATH="$(npm root -g)/mermaid-tui-mcp/src/server.mjs"`. The OpenClaw workaround 2 was rewritten to use a dynamic `import()` of the npm-resolved `render.mjs` path (via `npm root -g` + `pathToFileURL`) so it works without a local clone. The gsd-pi first-run trust prompt now shows `npx -y mermaid-tui-mcp` instead of a `node <abs-path>` command.

### Removed

- **`"private": true` from `package.json`** — the gate that prevented accidental `npm publish` is gone. The actual publish step is still a manual operator action (not run by CI); the `publishConfig.access: public` is the explicit declaration that the package is intended to be public.

## [0.3.0] - 2026-06-05

### Added

- **`OssStorage` — S3-compatible `StorageBackend` implementation (M002/S01).**
  - New `src/storage/OssStorage.mjs` implementing the full `StorageBackend` interface (13 methods: `load`, `save`, `sweep`, `put`, `getMetadata`, `readSvg`, `setPinned`, `remove`, `list`, `search`, `stats`, `pruneIfExpired`, `root`) over `@aws-sdk/client-s3`. Same Map+S3 pattern as `LocalFsStorage`: the in-memory index is the source of truth between `save()` calls; the persisted projection is `<prefix>/store.json` plus per-id `<id>.svg` blobs.
  - New env-driven factory `OssStorageFromEnv(env, opts)` that reads 5 required + 2 optional `MERMAID_OSS_*` vars and throws a typed `OssEnvInvalidError` (in-process code `-32006`, NOT mapped to the wire) on missing/empty values. Two optional vars: `MERMAID_OSS_PREFIX` (default `""`) and `MERMAID_OSS_FORCE_PATH_STYLE` (default `true`; MinIO + Aliyun OSS S3-compat both need path-style).
  - `readSvg` honors the 5 s read timeout (R005); `PutObject` / `DeleteObject` honor the 1× EAGAIN retry (R017); sweep bumps the existing `sweep_runs` / `sweep_removed` counters (R010) for parity with the local backend.
  - Tagged error mapping is unchanged: `StorageWriteError` (`-32004`) and `StorageReadError` (`-32005`) flow through the existing `registerTools` → `/health.last_errors` + `counters.render_errors` observability surface. Boot emits a single-line JSON `data: <bucket>` log so operators can confirm the cloud backend is wired before any tool runs.
- **`MERMAID_RENDERER_BACKEND=oss` factory wired into `src/server.mjs` (T03).** The previously stubbed `BACKEND === "oss"` branch now constructs an `OssStorage` from `process.env` via `OssStorageFromEnv(process.env, { counters, logger: log })`. Missing/empty env at boot causes `process.exit(1)` after a single-line JSON `oss_init_failed` stderr log; operators see the rejection at the boot layer, not buried in a generic crash. The boot log now reports `data: <bucket>` when `MERMAID_RENDERER_BACKEND=oss`.
- **7-tool stdio MCP integration over a real MinIO bucket (T04).** `tests/integration/stdio-mcp-oss.test.mjs` (14 `it()` blocks: 11 happy-path + 3 Q7 negatives) drives the same `src/tools.mjs` against `OssStorage` with **zero changes to `src/tools.mjs`** — the env switch is the only seam. The suite is TCP-probe-gated on `MERMAID_OSS_ENDPOINT`; absent a real S3 endpoint, it skips with a single stderr line and does not fail the suite. When the gate passes, four proof artifacts are written under `tests/integration/oss-proofs/`: `tools-list.json`, `render-result.json`, `file-link.html`, and a `README.md` index.
- **24 + 25 + 1 + 14 = 64 new unit + integration tests** covering env validation, the full 13-method surface against a stub `S3Client`, the boot factory, and the end-to-end 7-tool stdio flow over real MinIO.
- `bin/migrate-to-oss.mjs`: one-shot Local→Oss migration CLI (idempotent, dry-run-able, 4-of-5 post-sweep invariant, structured stderr JSON events: migrate_start / migrate_copy / migrate_skip / migrate_dry_run / migrate_read_failed / migrate_done).
- **Cloud integration verification across 5 clients, 7 tools, and 2 transport modes (M002/S03).**
  - **5-case MCP-Inspector protocol smoke over `MERMAID_RENDERER_BACKEND=oss`** (`tests/integration/mcp-inspector-oss.test.mjs`, 5 `it()` blocks, MinIO-gated): independent stdio driver mirroring the local-backend `mcp-inspector.test.mjs` pattern, asserting initialize handshake, tools/list (7 tools, spec order), and tools/call for render_mermaid, pin_mermaid, search_diagrams. Proof artifact `tests/integration/oss-proofs/mcp-inspector-tools-list.json` written by it() block 2 on a green run.
  - **4 browser-rendered cloud proof artifacts** under `tests/integration/cloud-proofs/` produced by a deterministic `capture-cloud-proofs.mjs`: `view-screenshot.png` (or `view-body.html` fallback) + `health.json` (full `/health` response with `version === "0.3.0"` + counters + last_errors) + `curl.txt` (transcript of the 3 HTTP probes) + `browser-evidence.md` (field-by-field assertions: `version`, `data` set to `<bucket>`, `counters.render_total ≥ 1`, `last_errors` empty).
  - **5 client integration docs updated** (`docs/integration/{claude-code,gsd-pi,hermes,openclaw,opencode}.md`) with a v0.3.0 cloud-storage section listing `MERMAID_RENDERER_BACKEND=oss`, the 5 required `MERMAID_OSS_*` env vars (`MERMAID_OSS_ENDPOINT`, `MERMAID_OSS_BUCKET`, `MERMAID_OSS_REGION`, `MERMAID_OSS_ACCESS_KEY_ID`, `MERMAID_OSS_SECRET_ACCESS_KEY`), and a pointer to `bin/migrate-to-oss.mjs` for existing-local → cloud migration. 5 new unit-test `it()` blocks added to `tests/unit/integration-docs.test.mjs` assert these keywords land in each doc.
  - **R027 10/10 evals re-run over the cloud backend** (`tests/evals/eval-cloud-rerun.test.mjs`, 10 `it()` blocks, MinIO-gated): re-validates the 10 eval contracts (render / pin / search / list / get / delete / title-anchor / multi-render / TTL / counter-bump) over `OssStorage` so R027 is held against the v0.3.0 surface, not just v0.2.0.
  - **2 real-client cloud smoke logs** (`tests/integration/real-client-smoke/{claude-code-cloud,gsd-pi-cloud}.{mjs,log}`): transport-level stdio smoke scripts driven against the live server with `MERMAID_RENDERER_BACKEND=oss`; their `.log` files are the v0.3.0 cloud proof that a real Claude Code / gsd-pi client can drive the same 7 tools end-to-end.
  - **M001 S04 `.log` backfill (MEM044):** committed the previously-missing `tests/integration/real-client-smoke/{claude-code,gsd-pi}.log` files so the local-backend smoke chain has both the script and its captured stderr output in git history.

### Changed

- **`src/server.mjs`** — the `BACKEND === "oss"` factory branch is now a real construction site (was a no-op stub). No other call site in `src/` was touched: the same `registerTools(tools, ctx, {storage, ...})` registration path is used regardless of backend, so the 7 tool handlers and the default `LocalFsStorage` impl are unchanged.
- **Storage error code family extended:** `OssEnvInvalidError.code = -32006` joins `StorageWriteError` (`-32004`) and `StorageReadError` (`-32005`). The code is in-process only — env-construction happens at boot, before any tool can run, so it is NOT mapped to the JSON-RPC wire.

### Deferred to subsequent slice summaries

- **M002/S03 — shipped in v0.3.0; see S03-SUMMARY for the close-out evidence (mcp-inspector-oss + cloud-proofs + 5 docs + eval-cloud-rerun + 2 cloud smoke logs).**

### Stats

- 251/251 + 20 skipped (MinIO-gated) on the v0.2.0-local surface.
- 83.4 % line coverage on included source files (above the 80 % gate enforced by `vitest.config.mjs`). New code: `src/storage/OssStorage.mjs` 96.0 % lines; `src/server.mjs` factory 100 % lines; `src/helpers.mjs` 100 % lines; `bin/migrate-to-oss.mjs` 70.2 % lines.
- CI: `.github/workflows/ci.yml` matrix on Node 22 + Node 24 with coverage threshold enforced on the Node 24 leg.

## [0.2.0] - 2026-06-04

### Added

- 7 stdio MCP tools (CRUD + pin):
  - `render_mermaid({code, title?})` — render to ASCII + self-contained HTML, returns `{id, ascii, fileLink, httpLink, title, elapsed_ms, warnings}`.
  - `pin_mermaid({id})` / `unpin_mermaid({id})` — protect a diagram from the 7-day sweep.
  - `get_diagram({id})` — fetch the full stored entry (including `code`, `title`, `pinned`, timestamps).
  - `list_diagrams({limit?, cursor?})` — paginated list of stored diagrams.
  - `search_diagrams({query, limit?})` — title-substring + code-substring match.
  - `delete_mermaid({id})` — explicit remove.
- `render_mermaid` now accepts an optional `title` parameter (≤200 chars) that is stored on the entry, rendered into the HTML viewer's `<title>`, and used as a search anchor.
- Storage backend abstraction: `StorageBackend` interface (JSDoc typedefs) with a `LocalFsStorage` default implementation; `OssStorage` deferred to M002.
- HTTP-standalone mode (`MERMAID_RENDERER_HTTP=1`): extended `/health` response with metrics (`counters`, `last_render_ms`, `last_errors[5]`).
- 10 `tests/evals/eval-XX.test.mjs` files (R027): 10/10 pass on the v0.2.0 surface.
- Self-contained browser viewer at `data/blobs/<id>.html` (XSS-guarded on the `title` field).

### Changed

- **Observability:** `console.error` text-prefixed log lines replaced with single-line JSON stderr logging (stable field order `{ts, level, event, code?, id?, ...rest}`). 7 log() call sites in `server.mjs` migrated.
- **Persistent counters:** `data/counters.json` written via tmp+rename atomic write; single-flight serialized `increment(key)`; corruption-tolerant `load()`. 6 counter keys: `render_total`, `render_errors`, `ascii_failures`, `storage_write_retries`, `sweep_runs`, `sweep_removed`.
- **Error contract:** full -32001..-32009 + -32602 + -32603 code set (R020) on top of the S02 envelope. New tagged error classes: `RenderTimeoutError`, `RenderFailedError`, `JsdomInitError`, `StorageReadError`, `PortInUseError`, `McpProtocolError`.
- **Retry paths:** 10s render timeout (R015), jsdom init 1× retry (R018), `writeFile` EAGAIN 1× retry (R017).
- **HTTP port fallback:** 5300 → 5301 → 5302 (R016) via `tryListen`; the 50ms inter-port sleep is `unref()`'d.
- **MEM024 closed:** `LocalFsStorage.list()` and `.search()` now project `{id, ...e}` in items; LLM clients can pin/get/delete by reference.
- **MEM017 fixed:** hourly sweep `setInterval` is `unref()`'d (no longer holds the process open).

### Stats

- 175/175 vitest tests passing (23 files, ~30 s) on Node 22 and Node 24.
- 80.95% line coverage on included source files (`helpers.mjs`, `render.mjs`, `LocalFsStorage.mjs`, `tools.mjs`, `logger.mjs`, `counters.mjs`, `errors.mjs`, `port-fallback.mjs`, `health-state.mjs`).
- CI: `.github/workflows/ci.yml` matrix on Node 22 + Node 24 with coverage threshold enforced on the Node 24 leg.

## [0.1.0] - 2026-06-04

### Added

- Initial release.
- stdio MCP server exposing the `render_mermaid` tool. The LLM calls it before emitting a ```mermaid code fence in its reply; the tool returns ASCII art (for the TUI command box) plus `fileLink` / `httpLink` view URLs.
- Optional HTTP-standalone mode (`MERMAID_RENDERER_HTTP=1`) bound to 127.0.0.1:5300 with `/view`, `/raw/svg`, `/pin`, `/health`. Activated by `bin/start.sh` / `bin/start.ps1` when you want the browser viewer + long-term pin to work.
- Self-contained HTML viewer written to `data/blobs/<id>.html` per render. Opens at `file://` in any browser without a running server.
- 7-day TTL sweep with optional `pin` (long-term storage) flag.
- mermaid 11 (jsdom + getBBox polyfill) for full-syntax rendering, mermaid-ascii for TUI output.
- Integration docs for gsd-pi, Claude Code, opencode, Hermes, OpenClaw.
