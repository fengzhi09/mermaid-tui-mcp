// src/tools.mjs — pure tool handlers + registerTools(mcp, ctx) wiring for the
// 7 stdio MCP tools.
//
// Why this file is "pure handlers + a registerTools helper" (no MCP SDK
// import beyond the registerTool call site):
//   - 7 handler functions, each async (args, ctx) => { ... }, depend only on
//     ctx.storage (StorageBackend), ctx.render (render.mjs), ctx.renderView
//     (helpers.mjs), and ctx.{dataDir, httpEnabled, httpHost, httpPort}.
//     No MCP SDK import. Unit tests can mock ctx and exercise the contract
//     without spawning the stdio transport.
//   - registerTools(mcp, ctx) is the single seam that imports the SDK
//     (because registerTool IS the SDK API). It enforces the R020 result
//     envelope + the elapsed_ms timer uniformly across all 7 tools.
//
// R020 envelope (from S02 spec):
//   success → { content: [{type:"text", text: JSON.stringify({...payload, elapsed_ms})}], warnings? merged into payload }
//   failure → { isError: true, content: [{type:"text", text: JSON.stringify({code, message, retryable})}] }
//
// Error code ranges used here (S02 minimal set; S03 will add -32001..-32009):
//   -32004 storage_write_failed (retryable, future-proof seam for write-time errors)
//   -32005 not_found           (NOT retryable — the id genuinely doesn't exist)

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { fileUrlFor } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// Tagged error classes — S03 may add more codes; the tagged-error pattern is
// the seam. The registerTools wrapper checks for `e.code` (a number) on
// caught errors and maps them to the R020 isError envelope.
// ---------------------------------------------------------------------------

export class NotFoundError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "NotFoundError";
		this.code = -32005;
		this.retryable = false;
	}
}

export class StorageWriteError extends Error {
	constructor(msg) {
		super(msg);
		this.name = "StorageWriteError";
		this.code = -32004;
		this.retryable = true;
	}
}

// ---------------------------------------------------------------------------
// Shared zod primitives — kept tiny so the per-tool shapes below read cleanly.
// ---------------------------------------------------------------------------

const Title = z.string().max(200).optional();
const Id = z.string().min(1).max(200);
const Limit = z.number().int().min(1).max(100).default(20);
const Cursor = z.string().min(1).max(200).optional();
const Pinned = z.boolean().optional();
const Query = z.string().min(1).max(200);
const Include = z.array(z.string()).optional();

// Per-tool input shapes. The zod schemas are exported implicitly via TOOL_DEFS
// (T03's server.mjs reads TOOL_DEFS[i].input when calling mcp.registerTool).
const InputRender = z.object({ code: z.string().min(1).max(200_000), title: Title });
const InputId = z.object({ id: Id });
const InputList = z.object({ limit: Limit, cursor: Cursor, pinned: Pinned });
const InputGet = z.object({ id: Id, include: Include });
const InputSearch = z.object({ query: Query, limit: Limit, cursor: Cursor, pinned: Pinned });

// ---------------------------------------------------------------------------
// Handlers — async (args, ctx) => { ... }. Each handler is responsible for
// its own validation surface (zod is enforced in the wrapper, not here).
// ---------------------------------------------------------------------------

/**
 * Detect the "ascii conversion failed" prefix that src/render.mjs emits when
 * mermaidToAscii throws. The renderer's actual format is
 *   `[mermaid-ascii failed: <reason>]\n<code>`
 * (note the closing `]`, NOT `)`). The renderer doesn't fail the whole
 * render on ASCII conversion errors (R025: ASCII is best-effort), so the
 * LLM gets the real SVG + a warnings: ["ascii_failed: ..."] hint instead.
 */
const ASCII_FAILED_PREFIX = "[mermaid-ascii failed:";

/**
 * R020 warnings array (R025) — only present when non-fatal issues surface.
 * Always return as `warnings: []` (not omitted) so LLM clients can pattern-match
 * the field without undefined guards.
 */
function maybeAsciiWarning(ascii) {
	if (typeof ascii !== "string" || !ascii.startsWith(ASCII_FAILED_PREFIX)) return [];
	// The marker ends at the first newline; the rest of the string is the
	// original code (per src/render.mjs's "[mermaid-ascii failed: ${msg}]\n${code}"
	// format). Extract `<msg>` between the prefix and the closing `]` on the
	// first line.
	const firstLine = ascii.split("\n", 1)[0];
	if (!firstLine.endsWith("]")) return [];
	const reason = firstLine.slice(ASCII_FAILED_PREFIX.length, -1).trim();
	return [`ascii_failed: ${reason}`];
}

/**
 * render_mermaid({code, title?}) — same shape as v0.1.0 plus title round-trip
 * + R020 elapsed_ms. The `title` arg is optional and defaults to "" in the
 * returned object.
 *
 * @param {{code: string, title?: string}} args
 * @param {{
 *   render: (code: string) => Promise<{id: string, svg: string, ascii: string, sourceLength: number}>,
 *   renderView: (id: string, entry: object, svg: string, withPinButton?: boolean) => Promise<string>,
 *   storage: import("./storage/Backend.mjs").StorageBackend,
 *   dataDir: string,
 *   httpEnabled: boolean,
 *   httpHost: string,
 *   httpPort: number,
 * }} ctx
 */
export async function renderMermaid(args, ctx) {
	const { code, title } = args;
	const { id, svg, ascii, sourceLength } = await ctx.render(code);
	await ctx.storage.put(id, code, svg, sourceLength, title);
	const entry = ctx.storage.getMetadata(id);
	if (!entry) {
		// put succeeded but the entry vanished — defensive. In practice this
		// is impossible (put is synchronous in memory after the disk write).
		throw new StorageWriteError(`put succeeded but entry vanished for ${id}`);
	}
	const html = await ctx.renderView(id, entry, svg);
	const htmlPath = join(ctx.dataDir, "blobs", `${id}.html`);
	await writeFile(htmlPath, html, "utf-8");
	const warnings = maybeAsciiWarning(ascii);
	return {
		id,
		ascii,
		fileLink: fileUrlFor(htmlPath),
		httpLink: ctx.httpEnabled ? `http://${ctx.httpHost}:${ctx.httpPort}/view?id=${id}` : null,
		title: title ?? "",
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

/**
 * pin_mermaid({id}) — flips the pin flag to true. Strict 404 (MEM014): a
 * missing id throws NotFoundError instead of returning a silent success.
 */
export async function pinMermaid(args, ctx) {
	const ok = await ctx.storage.setPinned(args.id, true);
	if (!ok) throw new NotFoundError(`diagram not found: ${args.id}`);
	return { id: args.id, pinned: true };
}

/**
 * unpin_mermaid({id}) — dual of pin_mermaid.
 */
export async function unpinMermaid(args, ctx) {
	const ok = await ctx.storage.setPinned(args.id, false);
	if (!ok) throw new NotFoundError(`diagram not found: ${args.id}`);
	return { id: args.id, pinned: false };
}

/**
 * list_diagrams({limit?, cursor?, pinned?}) — paginated, sorted createdAt desc.
 */
export async function listDiagrams(args, ctx) {
	return await ctx.storage.list({
		limit: args.limit,
		cursor: args.cursor,
		pinned: args.pinned,
	});
}

/**
 * get_diagram({id, include?}) — full object {id, title, code, ascii, svg, ...}.
 * The `include` field is accepted but not honored in S02 (always returns the
 * full object); it's a future M002 enhancement. Throws NotFoundError on miss.
 */
export async function getDiagram(args, ctx) {
	const entry = ctx.storage.getMetadata(args.id);
	if (!entry) throw new NotFoundError(`diagram not found: ${args.id}`);
	const svg = await ctx.storage.readSvg(args.id);
	return {
		id: args.id,
		title: entry.title ?? "",
		code: entry.code,
		ascii: "", // ASCII is intentionally not re-rendered on read; the tool
		//           contract returns what the original render produced. The
		//           caller can re-call render_mermaid if they want fresh ASCII.
		svg: svg ?? "",
		createdAt: entry.createdAt,
		lastAccessedAt: entry.lastAccessedAt,
		pinned: entry.pinned,
		sourceLength: entry.sourceLength,
	};
}

/**
 * delete_mermaid({id}) — strict 404 (MEM014): missing id throws, no idempotency.
 */
export async function deleteMermaid(args, ctx) {
	const ok = await ctx.storage.remove(args.id);
	if (!ok) throw new NotFoundError(`diagram not found: ${args.id}`);
	return { id: args.id, deleted: true };
}

/**
 * search_diagrams({query, limit?, cursor?, pinned?}) — title-first ranking.
 * Returns storage.search()'s output verbatim; that already includes
 * titleMatch:boolean and snippet:string per item.
 */
export async function searchDiagrams(args, ctx) {
	return await ctx.storage.search(args.query, {
		limit: args.limit,
		cursor: args.cursor,
		pinned: args.pinned,
	});
}

// ---------------------------------------------------------------------------
// Tool definitions — internal (not exported). Each entry is {name,
// description, input, run}. The registerTools wrapper below converts
// `{input: ZodObject}` into the SDK's `inputSchema` shape.
//
// Descriptions preserve the v0.1.0 render_mermaid wording (so eval-08's
// "draw anything" hint still lands), and add CRUD coverage for the 6 new
// tools. Each description is 1-3 sentences telling the LLM what the tool
// does and what its output looks like.
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
	{
		name: "render_mermaid",
		description:
			"Render a Mermaid diagram source string into terminal-safe ASCII art. " +
			"ALWAYS call this tool before emitting a ```mermaid code fence in your reply. " +
			"Return value: { id, ascii, fileLink, httpLink, title }. " +
			"Use `ascii` in your reply (replacing the raw mermaid source). " +
			"`fileLink` opens a self-contained HTML viewer at file:// in any browser. " +
			"`httpLink` opens the same viewer at http://127.0.0.1:5300 (only works if the " +
			"standalone HTTP daemon was started separately; ignore the 404 if not). " +
			"Pass an optional `title` (≤200 chars) so this diagram is searchable by name later.",
		input: InputRender,
		run: renderMermaid,
	},
	{
		name: "pin_mermaid",
		description:
			"Pin an existing diagram by id so it survives the 7-day TTL sweep. " +
			"Return value: { id, pinned: true }. Throws -32005 if the id is not found.",
		input: InputId,
		run: pinMermaid,
	},
	{
		name: "unpin_mermaid",
		description:
			"Unpin a previously pinned diagram by id so the 7-day TTL applies again. " +
			"Return value: { id, pinned: false }. Throws -32005 if the id is not found.",
		input: InputId,
		run: unpinMermaid,
	},
	{
		name: "list_diagrams",
		description:
			"List stored diagrams newest first, paginated. Optional `limit` (1-100, default 20), " +
			"`cursor` (opaque, from a previous nextCursor), and `pinned` filter (true/false). " +
			"Return value: { items, nextCursor } where each item carries id, title, code, " +
			"createdAt, lastAccessedAt, pinned, sourceLength.",
		input: InputList,
		run: listDiagrams,
	},
	{
		name: "get_diagram",
		description:
			"Fetch the full diagram object by id: { id, title, code, ascii, svg, " +
			"createdAt, lastAccessedAt, pinned, sourceLength }. The `include` field is " +
			"accepted but currently always returns the full object. Throws -32005 if missing.",
		input: InputGet,
		run: getDiagram,
	},
	{
		name: "delete_mermaid",
		description:
			"Permanently delete a diagram and its blob by id. Return value: { id, deleted: true }. " +
			"Throws -32005 if the id is not found (NOT idempotent — verify with list_diagrams first).",
		input: InputId,
		run: deleteMermaid,
	},
	{
		name: "search_diagrams",
		description:
			"Case-insensitive substring search across diagram titles (priority 1) and code (priority 2). " +
			"Optional `limit` (1-100, default 20), `cursor`, and `pinned` filter. " +
			"Return value: { items, nextCursor } where each item carries id, title, code, " +
			"pinned, createdAt, lastAccessedAt, sourceLength, titleMatch (true if the hit was in " +
			"the title), and snippet (60-char window around the match with <mark> wrapping the hit).",
		input: InputSearch,
		run: searchDiagrams,
	},
];

// ---------------------------------------------------------------------------
// registerTools(mcp, ctx) — the single seam that talks to the MCP SDK.
// Each call to mcp.registerTool wires one entry from TOOL_DEFS. The callback
// enforces the R020 envelope: success → {content: [{type:"text", text:
// JSON.stringify({...payload, elapsed_ms})}]}; failure (caught, tagged
// error) → {isError: true, content: [{type:"text", text: JSON.stringify(
// {code, message, retryable})}]}. Anything else re-throws (the SDK turns
// unknown throws into JSON-RPC -32603).
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   registerTool: (
 *     name: string,
 *     config: {description?: string, inputSchema?: unknown},
 *     cb: (args: unknown) => Promise<unknown>
 *   ) => unknown,
 * }} mcp  The MCP server (or a fake in tests). Only `registerTool` is touched.
 * @param {object} ctx  The runtime context (storage, render, renderView, dataDir, http*).
 */
export function registerTools(mcp, ctx) {
	for (const tool of TOOL_DEFS) {
		mcp.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: tool.input },
			async (args) => {
				const startNs = process.hrtime.bigint();
				try {
					const payload = await tool.run(args, ctx);
					const elapsed_ms = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
					return { content: [{ type: "text", text: JSON.stringify({ ...payload, elapsed_ms }) }] };
				} catch (e) {
					if (e && typeof e === "object" && typeof e.code === "number") {
						const elapsed_ms = Number((process.hrtime.bigint() - startNs) / 1_000_000n);
						const body = {
							code: e.code,
							message: String(e.message ?? e),
							retryable: !!e.retryable,
							elapsed_ms,
						};
						return {
							isError: true,
							content: [{ type: "text", text: JSON.stringify(body) }],
						};
					}
					// Unknown error: re-throw. The SDK converts it to JSON-RPC -32603.
					throw e;
				}
			},
		);
	}
}
