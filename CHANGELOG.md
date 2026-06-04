# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
