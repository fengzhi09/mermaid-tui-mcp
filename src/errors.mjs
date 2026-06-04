// src/errors.mjs — centralized error code namespace + classification.
//
// ============================================================================
// NAMESPACE DISAMBIGUATION (read this before editing the codes below)
// ============================================================================
// These error codes live in the INNER `error.code` field of an MCP
// CallToolResult with `isError: true`, NOT in the JSON-RPC envelope's
// top-level `error.code`. The two namespaces are separate:
//
//   JSON-RPC envelope (top-level `error.code`):
//     -32700  Parse error        (malformed JSON on the wire)
//     -32600  Invalid Request
//     -32601  Method not found
//     -32602  Invalid params     (zod validation, input shape)
//     -32603  Internal error
//     -32000  to -32099  Server errors (SDK-defined, e.g. transport-level
//                        ConnectionClosed -32000, RequestTimeout -32001)
//
//   Inner CallToolResult payload (this file's codes):
//     -32602  InvalidParams     — zod rejected the input shape
//     -32001  RenderTimeout     — mermaid.render() didn't return within timeout
//     -32002  RenderFailed      — mermaid parse error, empty/oversize source
//     -32003  JsdomInitFailed   — browser-shaped DOM globals init failed twice
//     -32004  StorageWriteFailed — disk write failed (terminal or retry exhausted)
//     -32005  StorageReadFailed  — disk read failed / timed out
//     -32008  PortInUse          — all candidate HTTP ports are taken
//     -32009  McpProtocolViolation — tool call violated the MCP contract
//
// The MCP SDK's transport-level -32000 (ConnectionClosed) and -32001
// (RequestTimeout) live in the JSON-RPC envelope and are DISTINCT from our
// inner-payload -32001 (RenderTimeout). Future readers — do not collapse
// these. The wire shape is:
//
//   { "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, ... } }    // envelope
//   {
//     "isError": true,
//     "content": [{ "type": "text",
//                   "text": "{\"error\":{\"code\":-32001,\"message\":\"...\"}}" }]
//   }                                                                 // inner
//
// ============================================================================

/**
 * Frozen enum of all error codes the renderer surfaces in the inner
 * CallToolResult payload. Object.freeze prevents accidental mutation —
 * these are part of the public wire contract (R020).
 */
export const ErrorCode = Object.freeze({
	InvalidParams: -32602,
	RenderTimeout: -32001,
	RenderFailed: -32002,
	JsdomInitFailed: -32003,
	StorageWriteFailed: -32004,
	StorageReadFailed: -32005,
	PortInUse: -32008,
	McpProtocolViolation: -32009,
});

// ---------------------------------------------------------------------------
// Tagged error classes — one per code. Each extends Error and sets
// `.code`, `.retryable`, and `.name` so the registerTools wrapper can
// pattern-match on `e.code is a number` and surface the R020 envelope.
//
// `retryable` is a hint to the LLM client: true means "you may try again
// after a short backoff"; false means "the failure is deterministic on
// the same input, do not retry". The MCP SDK does not act on this flag
// itself — it is purely a wire-level signal for the caller.
// ---------------------------------------------------------------------------

export class RenderTimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = "RenderTimeoutError";
		this.code = ErrorCode.RenderTimeout; // -32001
		this.retryable = true; // transient — client can retry after a backoff
	}
}

export class RenderFailedError extends Error {
	constructor(message) {
		super(message);
		this.name = "RenderFailedError";
		this.code = ErrorCode.RenderFailed; // -32002
		this.retryable = false; // mermaid parse error is deterministic on the same code
	}
}

export class JsdomInitError extends Error {
	constructor(message) {
		super(message);
		this.name = "JsdomInitError";
		this.code = ErrorCode.JsdomInitFailed; // -32003
		this.retryable = true; // init failure is often transient
	}
}

export class StorageReadError extends Error {
	constructor(message) {
		super(message);
		this.name = "StorageReadError";
		this.code = ErrorCode.StorageReadFailed; // -32005
		// retryable: true — distinct from src/tools.mjs's NotFoundError
		// (which uses the same code with retryable: false). A read timeout
		// is transient; a missing id is not.
		this.retryable = true;
	}
}

export class PortInUseError extends Error {
	constructor(message) {
		super(message);
		this.name = "PortInUseError";
		this.code = ErrorCode.PortInUse; // -32008
		this.retryable = true; // the port may free up
	}
}

export class McpProtocolError extends Error {
	constructor(message) {
		super(message);
		this.name = "McpProtocolError";
		this.code = ErrorCode.McpProtocolViolation; // -32009
		this.retryable = false; // a protocol violation is a client bug
	}
}

// ---------------------------------------------------------------------------
// classifyZodError(zodErr) → {code, message, retryable}
//
// Maps a zod error (ZodError instance, with `.issues[]`) to the R020
// inner-payload shape. The message joins all issue paths + messages with
// "; " so a single human-readable line surfaces every problem at once
// (e.g. "code: String must contain at least 1 character; title: String
// must contain at most 200 characters").
//
// We intentionally do NOT throw — this is a pure function used by the
// registerTools wrapper to translate a caught zod error into the
// CallToolResult envelope. Zod errors are validation rejections and
// always carry `code: -32602` (InvalidParams) with retryable: false
// (re-sending the same input will fail again).
// ---------------------------------------------------------------------------

/**
 * @param {{issues?: Array<{path?: Array<string|number>, message?: string}>} | null | undefined} zodErr
 * @returns {{code: number, message: string, retryable: boolean}}
 */
export function classifyZodError(zodErr) {
	const issues = Array.isArray(zodErr?.issues) ? zodErr.issues : [];
	const parts = issues.map((iss) => {
		const path = Array.isArray(iss?.path) && iss.path.length > 0 ? iss.path.join(".") : "(root)";
		const msg = typeof iss?.message === "string" ? iss.message : "invalid";
		return `${path}: ${msg}`;
	});
	const message = parts.length > 0 ? parts.join("; ") : "invalid input";
	return { code: ErrorCode.InvalidParams, message, retryable: false };
}

// ---------------------------------------------------------------------------
// classifyDomainError(err) → {code, message, retryable}
//
// Maps any thrown error to the R020 inner-payload shape. Used by the
// registerTools wrapper to handle non-zod failures (render-time, storage,
// unknown). Behaviour:
//
//   1. If err?.code is a number, trust the tagged error class and return
//      { code: err.code, message: String(err.message ?? err),
//        retryable: !!err.retryable }. This covers every tagged error
//      class in this file plus src/tools.mjs's NotFoundError /
//      StorageWriteError.
//
//   2. Otherwise pattern-match on err.message. The 3 known prefixes come
//      from src/render.mjs's 3 throw sites — keeping the substring
//      check (not a `code` match) means render.mjs stays a pure renderer
//      with no dependency on this module. The 9 existing eval tests
//      assert on the message text, so we DO NOT rewrite the message —
//      we only pick the right code + retryable flag.
//
//        "mermaid parse error: ..."      → -32002 RenderFailed (retryable: false)
//        "mermaid source too long ..."   → -32602 InvalidParams (retryable: false)
//        "empty mermaid source"          → -32602 InvalidParams (retryable: false)
//
//   3. Default → -32603 InternalError. The wrapper in registerTools
//      re-throws anything it cannot classify; the SDK converts that
//      throw into a JSON-RPC -32603 envelope. (We return -32603 here so
//      direct callers like unit tests get a sensible value, but the
//      production path goes through the re-throw.)
//
// Returns `{code, message, retryable}` — never throws.
// ---------------------------------------------------------------------------

/**
 * @param {unknown} err
 * @returns {{code: number, message: string, retryable: boolean}}
 */
export function classifyDomainError(err) {
	// 1) Trust tagged error classes (preserves .code + .retryable).
	if (err && typeof err === "object" && typeof err.code === "number") {
		return {
			code: err.code,
			message: String(err.message ?? err),
			retryable: !!err.retryable,
		};
	}
	// 2) Pattern-match the 3 known render.mjs throw prefixes.
	const msg = err && typeof err === "object" && typeof err.message === "string"
		? err.message
		: String(err);
	if (msg.startsWith("mermaid parse error:")) {
		return { code: ErrorCode.RenderFailed, message: msg, retryable: false };
	}
	if (msg.startsWith("mermaid source too long") || msg.startsWith("empty mermaid source")) {
		return { code: ErrorCode.InvalidParams, message: msg, retryable: false };
	}
	// 3) Unknown — re-thrown by the registerTools wrapper (surfaces as
	// JSON-RPC -32603). Returned here so direct callers don't crash.
	return { code: -32603, message: msg, retryable: false };
}

// ---------------------------------------------------------------------------
// renderError({code, message, retryable, ...rest})
//
// Builds the CallToolResult wire shape for a tagged failure. The result
// is `{ isError: true, content: [{ type: "text", text: JSON.stringify({
// error: { code, message, retryable, ...rest } }) }] }`. Used by tests to
// assert the wire shape and (in T05) by the registerTools wrapper as
// the canonical inner-payload builder.
//
// The `rest` fields flow into the inner `error` object verbatim so
// callers can attach diagnostic data (e.g. `{ port: 5300 }` for a
// PortInUseError). Stable key order: code, message, retryable, then
// ...rest in insertion order — matches the inner-payload contract.
// ---------------------------------------------------------------------------

/**
 * @param {{code: number, message: string, retryable: boolean, [key: string]: any}} payload
 * @returns {{isError: true, content: Array<{type: "text", text: string}>}}
 */
export function renderError(payload) {
	const { code, message, retryable, ...rest } = payload || {};
	const errorBody = { code, message, retryable, ...rest };
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify({ error: errorBody }) }],
	};
}
