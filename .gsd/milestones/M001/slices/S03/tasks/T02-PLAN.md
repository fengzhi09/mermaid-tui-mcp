---
estimated_steps: 11
estimated_files: 3
skills_used: []
---

# T02: Build errors module with the full -32001..-32009 + -32602 code set

Why: R020 (the error contract) and the 3 retry-path requirements (R015, R016, R017, R018) all need a centralized error code namespace + classification function. S02's tools.mjs already ships a partial implementation: NotFoundError (-32005, retryable: false) and StorageWriteError (-32004, retryable: true), used by 4 of the 7 tools. S03 must add the missing codes (-32001 render_timeout, -32002 render_failed, -32003 jsdom_init_failed, -32005 storage_read_failed (new class, retryable: true — distinct from NotFoundError which is retryable: false), -32008 port_in_use, -32009 mcp_protocol_violation) and the classifyDomainError function that maps the existing render.mjs Error throws (mermaid parse error, empty source, source too long) to the right codes without breaking the 9 existing eval tests that assert on the message text. The "code namespace" ambiguity (MCP SDK uses -32000/-32001 for transport-level codes) must be documented in a header comment so future readers don't collide.

Do:
1. Create src/errors.mjs — the centralized error module. Header comment documents the namespace disambiguation: "These error codes live in the inner `error.code` field of an MCP CallToolResult with isError: true, NOT in the JSON-RPC envelope `error.code`. The MCP SDK's transport-level -32000 (ConnectionClosed) and -32001 (RequestTimeout) are distinct from our -32001 (render_timeout)." Exports:
   - ErrorCode = Object.freeze({InvalidParams: -32602, RenderTimeout: -32001, RenderFailed: -32002, JsdomInitFailed: -32003, StorageWriteFailed: -32004, StorageReadFailed: -32005, PortInUse: -32008, McpProtocolViolation: -32009})
   - Tagged error classes (one per code, each extends Error and sets .code + .retryable + .name): RenderTimeoutError, RenderFailedError, JsdomInitError, StorageReadError (retryable: true, distinct from S02's NotFoundError which uses the same code with retryable: false), PortInUseError, McpProtocolError
   - classifyZodError(zodErr) → {code: -32602, message: "path: msg; path2: msg2", retryable: false} — joins zodErr.issues with "; " separator
   - classifyDomainError(err) → {code, message, retryable} — if err?.code is a number, return it with message from err.message; otherwise pattern-match on err.message: "mermaid parse error:" → {code: -32002, ...}; "mermaid source too long" or "empty mermaid source" → {code: -32602, ...}; default → {code: -32603, ...} (re-thrown by registerTools wrapper, surfaces as JSON-RPC -32603 to the client)
   - renderError({code, message, retryable, ...rest}) → {isError: true, content: [{type: "text", text: JSON.stringify({error: {code, message, retryable, ...rest}})}]} — used by tests to assert the wire shape
2. Update src/tools.mjs — add 2 new lines near the top: `import { RenderTimeoutError, RenderFailedError, JsdomInitError, StorageReadError, PortInUseError, McpProtocolError, classifyDomainError, classifyZodError, ErrorCode } from "./errors.mjs";` and re-export them: `export { RenderTimeoutError, RenderFailedError, JsdomInitError, StorageReadError, PortInUseError, McpProtocolError, classifyDomainError, classifyZodError, ErrorCode };` The 2 existing classes (NotFoundError, StorageWriteError) stay where they are; S03 only adds the 6 new ones in errors.mjs. The registerTools wrapper stays unchanged in T02 — it will gain counters + structured log wiring in T05.
3. Create tests/unit/errors.test.mjs (8-10 cases). Assert: ErrorCode.RenderTimeout === -32001, ErrorCode.RenderFailed === -32002, ErrorCode.JsdomInitFailed === -32003, ErrorCode.StorageWriteFailed === -32004, ErrorCode.StorageReadFailed === -32005, ErrorCode.PortInUse === -32008, ErrorCode.McpProtocolViolation === -32009, ErrorCode.InvalidParams === -32602 (all 8 codes); each error class extends Error and has .code + .retryable + .name set; the StorageReadError is retryable: true while NotFoundError is retryable: false (both -32005, different retryable — locked by assertion); classifyZodError handles a multi-issue zod error with "; " separator; classifyDomainError maps "mermaid parse error: ..." → -32002; classifyDomainError maps "mermaid source too long (200001 chars, max 200000)" → -32602 (preserves the eval-07 message text); classifyDomainError maps an error with err.code === -32001 → -32001; renderError produces the {isError: true, content: [{type: "text", text: JSON.stringify({error: {code, message, retryable}})}]} shape.

Done when: `npm test -- tests/unit/errors.test.mjs` exits 0; the 6 new error classes are importable from both src/errors.mjs and src/tools.mjs; the classifyDomainError function correctly maps all 3 known render.mjs error message prefixes; the namespace disambiguation comment is in place.

## Inputs

- `src/tools.mjs`
- `src/render.mjs`

## Expected Output

- `src/errors.mjs`
- `tests/unit/errors.test.mjs`
- `src/tools.mjs`

## Verification

npm test -- tests/unit/errors.test.mjs

## Observability Impact

adds structured error code namespace (-32001..-32009, -32602) on top of the R020 envelope; adds 6 new tagged error classes for the retry paths; documents the code-vs-SDK-namespace disambiguation in a header comment
