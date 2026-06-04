# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-04

### Added

- Initial release.
- stdio MCP server exposing the `render_mermaid` tool. The LLM calls it before emitting a ```mermaid code fence in its reply; the tool returns ASCII art (for the TUI command box) plus `fileLink` / `httpLink` view URLs.
- Optional HTTP-standalone mode (`MERMAID_RENDERER_HTTP=1`) bound to 127.0.0.1:5300 with `/view`, `/raw/svg`, `/pin`, `/health`. Activated by `bin/start.sh` / `bin/start.ps1` when you want the browser viewer + long-term pin to work.
- Self-contained HTML viewer written to `data/blobs/<id>.html` per render. Opens at `file://` in any browser without a running server.
- 7-day TTL sweep with optional `pin` (long-term storage) flag.
- mermaid 11 (jsdom + getBBox polyfill) for full-syntax rendering, mermaid-ascii for TUI output.
- Integration docs for gsd-pi, Claude Code, opencode, Hermes, OpenClaw.
