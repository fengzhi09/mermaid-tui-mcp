// extensions/gsd-pi-mermaid/index.ts
//
// gsd-pi extension that wires the 7 mermaid-tui-mcp stdio MCP tools into the
// gsd-pi tool surface, bypassing the broken mcp_call transport (which
// double-escapes the `code` arg for multi-line Mermaid source — verified
// independently: direct stdio roundtrip succeeds, mcp_call roundtrip
// produces literal `\n` in the parsed string, the Mermaid 11 parser then
// chokes on a single-line input).
//
// The transport here is a long-lived child process + raw JSON-RPC over
// stdio, encapsulated in MermaidClient.ts (no gsd-pi imports → fully unit
// testable in isolation). Each tool here is a thin pass-through.

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@gsd/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MermaidClient, defaultServerPath } from "./MermaidClient.js";

interface ExtensionState {
	client: MermaidClient;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const STATE_KEY = Symbol.for("mermaid-direct/client");

function getClient(pi: ExtensionAPI): MermaidClient {
	const anyPi = pi as unknown as { [STATE_KEY]?: MermaidClient };
	if (anyPi[STATE_KEY]) return anyPi[STATE_KEY]!;

	// Resolve server path: PI_PROJECT_DIR (gsd-pi standard) > cwd > fallback
	const projectRoot = process.env.PI_PROJECT_DIR || process.cwd();
	const serverPath = process.env.MERMAID_SERVER_PATH || defaultServerPath(projectRoot);

	const client = new MermaidClient({
		serverPath,
		// Pass through the operator's env (e.g. MERMAID_RENDERER_DATA,
		// MERMAID_OSS_*) so the spawned server sees the same configuration
		// they would see if they ran it directly. The process.env merge
		// inside MermaidClient already includes these from the parent.
	});
	anyPi[STATE_KEY] = client;

	// Best-effort shutdown when the session ends — don't leak the spawned
	// server process between gsd-pi sessions.
	pi.on("session_shutdown", async () => {
		try {
			await client.close();
		} catch {
			/* swallow */
		}
	});

	return client;
}

/** Pull the JSON-parsed payload out of an MCP result.content[0].text envelope. */
function unwrap(resp: { result?: { content?: Array<{ type: string; text?: string }> }; error?: { code: number; message: string } }): unknown {
	if (resp.error) {
		throw new Error(`mermaid server error ${resp.error.code}: ${resp.error.message}`);
	}
	const text = resp.result?.content?.[0]?.text;
	if (typeof text !== "string") {
		throw new Error("mermaid server response missing content[0].text");
	}
	try {
		return JSON.parse(text);
	} catch {
		// Not JSON — return the raw text (e.g. ASCII error envelopes with the
		// "[mermaid-ascii failed: ...]" sentinel). The model can still use it.
		return text;
	}
}

/** Truncate + return the formatted result for the LLM. */
function asToolResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; details: { data: unknown } } {
	const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let out = truncation.content;
	if (truncation.truncated) {
		out += `\n\n[Output truncated: ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
	}
	return {
		content: [{ type: "text", text: out }],
		// details.data is what gsd-pi stores for state + renderResult branching.
		// The LLM sees `content`; the UI sees `details`.
		details: { data: payload },
	};
}

function elapsedMsShape() {
	return Type.Object({ elapsed_ms: Type.Optional(Type.Number()) });
}

export default function activate(pi: ExtensionAPI) {
	// Lazy client — the spawn happens on the first tool call, not at
	// extension load. Keeps gsd-pi startup snappy when mermaid isn't used.

	pi.registerTool({
		name: "mermaid_render",
		label: "Mermaid Render",
		description:
			"Render a Mermaid diagram source string into terminal-safe ASCII art. " +
			"ALWAYS call this tool before emitting a ```mermaid code fence in your reply. " +
			"Returns: { id, ascii, fileLink, httpLink, title, warnings, elapsed_ms }. " +
			"Use `ascii` in your reply (replacing the raw mermaid source). " +
			"`fileLink` opens a self-contained HTML viewer at file:// in any browser. " +
			"Optional `title` (≤200 chars) makes the diagram searchable later. " +
			"NOTE: this is the gsd-pi-direct transport variant of mermaid-tui-mcp; " +
			"multi-line source survives intact here even when the standard mcp_call " +
			"transport would double-escape newlines.",
		promptSnippet: "Render mermaid source to ASCII (direct transport, no mcp_call double-escape)",
		parameters: Type.Object({
			code: Type.String({ description: "Mermaid source. Multi-line strings are supported (real newlines preserved)." }),
			title: Type.Optional(Type.String({ maxLength: 200, description: "Human label so the diagram is searchable later" })),
		}),
		async execute(_id, params, signal) {
			try {
				if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
				const client = getClient(pi);
				const resp = await client.callTool("render_mermaid", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_render failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_pin",
		label: "Mermaid Pin",
		description: "Pin an existing diagram by id so it survives the 7-day TTL sweep. Returns { id, pinned: true }.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 200, description: "Diagram id (from render_mermaid or list_diagrams)" }),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("pin_mermaid", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_pin failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_unpin",
		label: "Mermaid Unpin",
		description: "Unpin a previously pinned diagram by id so the 7-day TTL applies again. Returns { id, pinned: false }.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 200, description: "Diagram id" }),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("unpin_mermaid", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_unpin failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_get",
		label: "Mermaid Get",
		description:
			"Fetch the full diagram object by id: { id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength }. " +
			"Throws if the id is missing (use mermaid_list to find valid ids).",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 200, description: "Diagram id" }),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("get_diagram", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_get failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_list",
		label: "Mermaid List",
		description:
			"List stored diagrams newest first, paginated. " +
			"Optional `limit` (1-100, default 20), `cursor` (opaque, from a previous nextCursor), and `pinned` filter (true/false). " +
			"Returns: { items, nextCursor }.",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
			cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			pinned: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("list_diagrams", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_list failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_search",
		label: "Mermaid Search",
		description:
			"Case-insensitive substring search across diagram titles (priority 1) and code (priority 2). " +
			"Optional `limit` (1-100, default 20), `cursor`, and `pinned` filter. " +
			"Returns: { items, nextCursor } where each item carries id, title, code, pinned, createdAt, lastAccessedAt, sourceLength, titleMatch, snippet.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 200 }),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 20 })),
			cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
			pinned: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("search_diagrams", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_search failed: ${(e as Error).message}`);
			}
		},
	});

	pi.registerTool({
		name: "mermaid_delete",
		label: "Mermaid Delete",
		description:
			"Permanently delete a diagram and its blob by id. " +
			"Returns { id, deleted: true }. Throws if the id is not found (NOT idempotent — verify with mermaid_list first).",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 200, description: "Diagram id" }),
		}),
		async execute(_id, params, signal) {
			try {
				const client = getClient(pi);
				const resp = await client.callTool("delete_mermaid", params as Record<string, unknown>, {
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				});
				return asToolResult(unwrap(resp));
			} catch (e) {
				throw new Error(`mermaid_delete failed: ${(e as Error).message}`);
			}
		},
	});
}
