// src/logger.mjs — structured stderr JSON logger.
//
// R008 requires every log line to be a single, parseable JSON object
// with stable field order: ts, level, event, code?, id?, ...rest. The
// order matters for human grep'ability and for downstream log shippers
// that index by field position. We do not use console.* because stdout
// is reserved for the MCP JSON-RPC stream in stdio mode — only
// process.stderr is safe to write to.
//
// code and id are OPTIONAL: when the caller passes null/undefined we
// MUST omit the field (not emit "code": null) so consumers do not have
// to distinguish "missing" from "explicit null". Use `code` for
// machine-readable error codes (-32001..-32009, -32601, -32602) and
// `id` for the diagram id when a log line refers to one specific item.
//
// process.stderr.write is wrapped in try/catch so an EPIPE (consumer
// disconnected during shutdown) does not crash the renderer — the log
// is best-effort and a dropped log is preferable to a non-graceful
// exit. Other write errors are still swallowed because the renderer
// must keep running even if logging fails.

/**
 * Emit one structured JSON log line to stderr.
 *
 * @param {object} record
 * @param {string} record.event                    required, machine-readable event name
 * @param {string} [record.level="info"]           "info" | "warn" | "error" | "debug"
 * @param {number|null} [record.code]              optional error/code number; null/undefined → omitted
 * @param {string|null} [record.id]                optional diagram id; null/undefined → omitted
 * @param {...any} [record.rest]                   any extra fields, preserved in insertion order
 * @returns {void}
 */
export function log(record) {
	const { level = "info", event, code, id, ...rest } = record || {};
	// Defensive: if a caller forgets `event` we still emit a parseable line
	// with event="unknown" so the JSON shape never breaks. We do NOT throw —
	// logging must never crash the renderer.
	const safeEvent = typeof event === "string" && event.length > 0 ? event : "unknown";
	const safeLevel = typeof level === "string" && level.length > 0 ? level : "info";
	const body = {
		ts: new Date().toISOString(),
		level: safeLevel,
		event: safeEvent,
		...(code != null ? { code } : {}),
		...(id != null ? { id } : {}),
		...rest,
	};
	let line;
	try {
		line = JSON.stringify(body) + "\n";
	} catch {
		// Non-serialisable extras (e.g. circular refs). Fall back to a minimal
		// record so the log line is still well-formed JSON.
		const minimal = { ts: body.ts, level: body.level, event: body.event, ...(body.code != null ? { code: body.code } : {}), ...(body.id != null ? { id: body.id } : {}), _serialize_error: true };
		line = JSON.stringify(minimal) + "\n";
	}
	try {
		process.stderr.write(line);
	} catch {
		// Best-effort: an EPIPE or other stderr failure is not fatal.
	}
}
