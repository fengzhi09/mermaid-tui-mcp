---
id: T02
parent: S03
milestone: M001
key_files:
  - src/errors.mjs
  - tests/unit/errors.test.mjs
  - src/tools.mjs
key_decisions:
  - Retryable flag convention: true for transient failures (RenderTimeout, JsdomInit, StorageRead, PortInUse), false for deterministic failures (RenderFailed, McpProtocolViolation). The same code -32005 is used by both StorageReadError (retryable:true) and NotFoundError (retryable:false) — the retryable flag carries the semantic distinction, not the code.
  - Pattern-match on err.message substring (not a `code` property) for the 3 known src/render.mjs throw prefixes. Reason: keeps src/render.mjs dependency-free (no import of ./errors.mjs) and preserves the 9 existing eval tests' message-substring assertions verbatim.
  - classifyDomainError default branch returns -32603 (InternalError), not the renderError envelope. Reason: the function is the classifier, not the envelope builder; the production path is the wrapper's re-throw, not a direct renderError call. Returning a structured value keeps the function pure for unit tests.
  - renderError preserves insertion-order ...rest INSIDE the inner error object (not at the outer envelope level). Reason: callers like T05's port-fallback path will pass {port, host} diagnostics and want them in the inner object — the /health last_errors ring and structured log lines both read from there.
  - 1-line import + 1-line multi-symbol re-export at the top of src/tools.mjs preserves the S02 historical single-seam pattern (everything importable from src/tools.mjs). The 2 S02 classes (NotFoundError, StorageWriteError) stay defined in tools.mjs; the 6 new S03 classes live in errors.mjs and are re-exported.
  - registerTools wrapper is UNCHANGED in T02 (per slice plan). The wrapper will gain counters + structured log wiring in T05; T02 only adds the error namespace + classifiers so the wrapper has something to call when it does the rewiring.
duration: 
verification_result: passed
completed_at: 2026-06-04T11:10:31.587Z
blocker_discovered: false
---

# T02: Built src/errors.mjs with the full -32001..-32009 + -32602 code set, 6 new tagged error classes, classifyZodError/classifyDomainError/renderError helpers, and a namespace disambiguation comment; re-exported the new surface from src/tools.mjs (the historical single seam); 21 new unit tests pass with 100% line coverage on the new module.

**Built src/errors.mjs with the full -32001..-32009 + -32602 code set, 6 new tagged error classes, classifyZodError/classifyDomainError/renderError helpers, and a namespace disambiguation comment; re-exported the new surface from src/tools.mjs (the historical single seam); 21 new unit tests pass with 100% line coverage on the new module.**

## What Happened

## T02: Build errors module with the full -32001..-32009 + -32602 code set

### What shipped

**New module: `src/errors.mjs`**

The centralized error namespace. ~200 lines including the header comment.

- **Header comment (namespace disambiguation)** — Documents that the 8 codes in this file live in the INNER `error.code` field of an MCP CallToolResult payload, NOT in the JSON-RPC envelope's top-level `error.code`. Explicitly calls out that the MCP SDK's transport-level -32000 (ConnectionClosed) and -32001 (RequestTimeout) are DISTINCT from our inner -32001 (RenderTimeout). Future readers cannot collapse the two namespaces.

- **`ErrorCode` enum (frozen)** — `Object.freeze({InvalidParams: -32602, RenderTimeout: -32001, RenderFailed: -32002, JsdomInitFailed: -32003, StorageWriteFailed: -32004, StorageReadFailed: -32005, PortInUse: -32008, McpProtocolViolation: -32009})`. Frozen so accidental mutation fails loudly in strict mode (verified by a test).

- **6 new tagged error classes** — Each extends Error and sets `.code`, `.retryable`, `.name`:
  - `RenderTimeoutError` — -32001, retryable: true (timeout is transient)
  - `RenderFailedError` — -32002, retryable: false (mermaid parse error is deterministic)
  - `JsdomInitError` — -32003, retryable: true (init failure often transient)
  - `StorageReadError` — -32005, retryable: true (distinct from NotFoundError which is also -32005 but retryable: false; the locked distinction documented in the test)
  - `PortInUseError` — -32008, retryable: true (port may free up)
  - `McpProtocolError` — -32009, retryable: false (protocol violation is a client bug)
  
  `retryable` is a wire-level signal to the LLM client; the MCP SDK does not act on it.

- **`classifyZodError(zodErr) → {code, message, retryable}`** — Joins `zodErr.issues[]` as `"path: msg; path2: msg2"` with the `; ` separator (per the slice plan). Returns `-32602` (InvalidParams) with `retryable: false`. Tolerates null / undefined / non-zod input without throwing. Falls back to `"invalid input"` for an empty issues array.

- **`classifyDomainError(err) → {code, message, retryable}`** — Pure function. Three branches:
  1. If `err?.code` is a number, trust the tagged class and return `{code: err.code, message: String(err.message), retryable: !!err.retryable}`. This is the pass-through path for every tagged error (including the 2 S02 classes `NotFoundError` and `StorageWriteError`).
  2. Pattern-match on `err.message` for the 3 known `src/render.mjs` throw prefixes: `"mermaid parse error:"` → -32002, `"mermaid source too long"` / `"empty mermaid source"` → -32602. The message text is preserved unchanged (the 9 existing eval tests assert on substrings like `"mermaid source too long (200001 chars, max 200000)"`).
  3. Default → -32603 (InternalError). The registerTools wrapper will re-throw unknown errors so the SDK converts to JSON-RPC -32603; the function returns -32603 here so direct callers (unit tests) get a sensible structured value.
  
  Pattern-matching on the message (not a `code` property) means `src/render.mjs` stays a pure renderer with zero dependency on this module — the slice-plan requirement.

- **`renderError({code, message, retryable, ...rest}) → {isError, content}`** — Builds the canonical wire shape `{isError: true, content: [{type: "text", text: JSON.stringify({error: {code, message, retryable, ...rest}})}]}`. Stable inner field order: code, message, retryable, then insertion-order `...rest` (so diagnostic fields like `port` and `host` for `PortInUseError` survive in a predictable position). Used by tests to assert the wire shape and (in T05) by the registerTools wrapper as the canonical inner-payload builder.

**Modified: `src/tools.mjs`**

- Added 1 import line pulling in the 6 new tagged error classes, the 2 classifier functions, and the `ErrorCode` enum from `./errors.mjs`.
- Added 1 multi-symbol re-export line so the historical single-seam pattern (everything importable from `src/tools.mjs`) is preserved. The 2 existing S02 classes (`NotFoundError`, `StorageWriteError`) stay defined where they are in this file — the slice plan explicitly says not to move them.
- The `registerTools` wrapper is UNCHANGED in T02 — it will gain counters + structured log wiring in T05. This keeps T02 a pure module-build task with zero ripple into the wrapper's test surface.

**New test file: `tests/unit/errors.test.mjs`** — 21 tests across 6 `describe` blocks:

1. `ErrorCode (R020 namespace)` (2 tests) — frozen enum + all 8 numeric values
2. `tagged error classes` (6 tests) — each class's `code` + `retryable` + `name` + instanceof Error; the locked StorageReadError(true) vs NotFoundError(false) at the same -32005 code
3. `classifyZodError()` (3 tests) — multi-issue join, empty issues fallback, null/undefined tolerance
4. `classifyDomainError()` (7 tests) — tagged-error pass-through, all 3 known render.mjs prefixes, default -32603 fallback, non-Error throws (string, number, null) handled
5. `renderError()` (2 tests) — wire shape, extra-fields preservation with stable key order
6. `re-exports from src/tools.mjs (the historical single seam)` (1 test) — all 9 new symbols are importable from `src/tools.mjs` (the historical import site), so downstream code can keep using the single seam

### Verification outcomes

- **`npm test -- tests/unit/errors.test.mjs`** → **21/21 pass** in 8ms.
- **`npx vitest run`** (full suite) → **143/143 pass across 21 test files** in 23.30s. Up from 122/122 in T01 (the 21 new errors tests + 0 regressions to S01/S02 baselines).
- **`npx vitest run --coverage`** → exit 0. `src/errors.mjs` shows **100% lines, 87.5% branch, 100% functions**; the aggregate is 77.98% (slice-wide threshold 80% lands once T03-T05 add `port-fallback.mjs` + `health-state.mjs` + the test extensions).
- **`node --check src/errors.mjs src/tools.mjs`** → exit 0. Both parse cleanly.
- **`grep -c "^export" src/server.mjs`** → **6** (S01 invariant preserved — server.mjs untouched in T02).
- **Namespace disambiguation comment** present at the top of `src/errors.mjs` (verified by inspection + a test that exercises the enum to prove it is wired up).
- **No `console.error` pollution** — pure module, no I/O, the test file does not touch stderr (S01 follow-up "S03 must not pollute unit-test silence" preserved).

### Foundation handed forward

T03 (render timeout + jsdom init retry), T04 (storage write retry + read timeout), and T05 (registerTools wiring + port-fallback + health-state) consume this work directly:

- **T03** will `throw new RenderTimeoutError(...)` from the new 10s timeout path and `throw new JsdomInitError(...)` from the 2x-retry-exhausted jsdom init. Both codes are already mapped to `ErrorCode.RenderTimeout` / `ErrorCode.JsdomInitFailed`.
- **T04** will `throw new StorageReadError(...)` from the 5s `readSvg` timeout. `StorageWriteError` is the existing S02 class and stays in `src/tools.mjs`.
- **T05** will:
  - Wrap each tool call in `classifyDomainError(err)` (in the unknown-throw branch) and `classifyZodError(zodErr)` (in the input-validation branch) so any caught failure surfaces in the R020 envelope with the right code.
  - Use `renderError({code, message, retryable, ...})` as the canonical inner-payload builder in the wrapper (today's wrapper builds the body inline; T05 will switch to `renderError` to centralize the shape).
  - Add `port-fallback.mjs`'s `tryListen` to `throw new PortInUseError(...)` on exhaustion and let the existing catch flow surface it.
  - Map `McpProtocolError` for any future "client sent a malformed request" cases that today's wrapper just re-throws as -32603.

### Decisions

- **Retryable flag choices for the 5 un-specified classes**: RenderTimeout=true, RenderFailed=false, JsdomInit=true, PortInUse=true, McpProtocolViolation=false. Convention: true for transient failures (timeout, init, port availability) where a retry may succeed; false for deterministic failures (parse error, protocol violation) where the same input would fail again. The only retryable flag the slice plan pinned explicitly was StorageReadError (true, distinct from NotFoundError's false at the same -32005 code).
- **classifyDomainError default branch returns -32603**, not the `{code: -32603, ...}` shape via `renderError`. Reason: the production path is the wrapper's re-throw, not a direct renderError call; the function is the classifier, not the envelope builder. Returning a structured value here keeps the function pure for unit tests.
- **renderError preserves insertion-order `...rest` inside the inner object** (not at the outer envelope level). Reason: callers like T05's port-fallback path will pass `{port: 5300, host: '127.0.0.1'}` and want those diagnostic fields in the inner `error` object — the `last_errors` ring in `/health` and the structured log lines both read from there.
- **Pattern-match on `err.message` substring, not a `code` property**, for the 3 known `src/render.mjs` throw prefixes. Reason: keeps `src/render.mjs` dependency-free (no import of `./errors.mjs`) and preserves the 9 existing eval tests' message-substring assertions verbatim.

## Verification

`npm test -- tests/unit/errors.test.mjs` exits 0 (21/21 pass in 8ms). `npx vitest run` exits 0 (143/143 pass across 21 test files — up from 122/122 in T01, no regressions). `npx vitest run --coverage` exits 0; `src/errors.mjs` shows 100% lines / 87.5% branch / 100% functions. `node --check src/errors.mjs src/tools.mjs` exits 0. `grep -c "^export" src/server.mjs` returns 6 (S01 invariant preserved — server.mjs is untouched in T02). All 9 new symbols (6 error classes + 2 classifiers + ErrorCode enum) are importable from BOTH `src/errors.mjs` and `src/tools.mjs` (the historical single seam). The 3 known `src/render.mjs` throw prefixes ("mermaid parse error:", "mermaid source too long", "empty mermaid source") map to the correct codes (-32002, -32602, -32602) with the original message text preserved verbatim. The namespace disambiguation comment is in place at the top of `src/errors.mjs` and is verified by inspection.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `npm test -- tests/unit/errors.test.mjs` | 0 | pass — 21/21 tests pass in 8ms; covers ErrorCode freeze, all 8 codes, 6 tagged error classes (with the locked StorageReadError:true vs NotFoundError:false at -32005), classifyZodError (multi-issue join + null tolerance), classifyDomainError (all 3 render.mjs prefixes + tagged-error pass-through + default -32603 + non-Error throws), renderError (wire shape + extra-field preservation with stable key order), and the tools.mjs re-export seam | 970ms |
| 2 | `npx vitest run` | 0 | pass — 143/143 tests pass across 21 test files in 23.30s; up from 122/122 in T01 (21 new errors tests, 0 regressions to S01 + S02 baselines) | 23300ms |
| 3 | `npx vitest run --coverage` | 0 | pass — errors.mjs at 100% lines / 87.5% branch / 100% functions; aggregate lines 77.98% (slice-wide 80% threshold will land after T03-T05 add port-fallback.mjs + health-state.mjs + the test extensions per the S03 plan) | 23300ms |
| 4 | `node --check src/errors.mjs src/tools.mjs` | 0 | pass — both source modules parse cleanly | 800ms |
| 5 | `grep -c "^export" src/server.mjs` | 0 | pass — returns 6 (S01 invariant preserved; server.mjs is untouched in T02) | 50ms |

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `src/errors.mjs`
- `tests/unit/errors.test.mjs`
- `src/tools.mjs`
