# mermaid-tui-mcp

## What This Is

A local Model Context Protocol (MCP) server that lets any coding agent render Mermaid diagrams into the terminal command box. The LLM calls `render_mermaid` instead of emitting a raw ```mermaid block. The user gets ASCII art inline plus a clickable link to the rendered diagram in a browser.

Version: 0.1.0 (v0.2.0 planned in M001)

## Core Value

The TUI command box cannot render Mermaid natively. Without this server, an LLM that wants to show a diagram emits a raw ```mermaid code block, which appears as source in the TUI. This server gives the LLM one tool that returns ASCII art (TUI-friendly) plus a browser-viewable link.

If scope must shrink, this capability must survive.

## Project Shape

- **Complexity:** complex
- **Why:** Multiple client integrations (5), dual transport (stdio + HTTP), non-trivial observability and error contracts, deferred cloud ambitions.

## Current State

- v0.1.0 published (with package, license, changelog, security, contributing docs)
- Single MCP tool: `render_mermaid({code})` → `{id, ascii, fileLink, httpLink}`
- Optional HTTP daemon on 127.0.0.1:5300 (4 endpoints: /view, /pin, /raw/svg, /health)
- Self-contained HTML viewer (file:// works offline)
- 7-day TTL + pin (HTTP-only)
- Storage: data/store.json + data/blobs/<id>.{svg,html}
- 5 client integration docs written (gsd-pi, Claude Code, opencode, Hermes, OpenClaw)
- 10 eval questions in evals.xml (documentation, not yet executable)
- No test framework, no CI
- @modelcontextprotocol/sdk 1.29, mermaid 11.15, jsdom 25.0.1, mermaid-ascii 1.0

## Architecture / Key Patterns

- Single process, dual transport (stdio MCP default + optional HTTP companion)
- Async/await throughout, ESM modules, camelCase
- Stderr-only logging (stdout reserved for JSON-RPC stream)
- Graceful shutdown via SIGINT/SIGTERM with 3s drain
- Idempotent load() (corrupted store.json starts fresh)
- Sweep policy: now - createdAt > 7d AND !pinned ⇒ delete; runs on load, on put, hourly
- No network calls; local FS only

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: v0.2.0 收口 — 测试 + CI、MCP 工具补齐(7 个)、可观测性、集成验证
- [ ] M002: (deferred) 云存储 + 账户 + 订阅
- [ ] M003: (deferred) 性能 / 可靠性深化 / 更多 MCP 工具
