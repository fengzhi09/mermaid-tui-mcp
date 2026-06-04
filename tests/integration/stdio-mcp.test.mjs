// tests/integration/stdio-mcp.test.mjs — drives the real server as a child
// process over stdio JSON-RPC. Locks the S02 MCP surface (initialize,
// tools/list, tools/call) under vitest so a future change to src/server.mjs
// or src/tools.mjs can't silently break the protocol contract that
// gsd-pi depends on.
//
// What this file locks:
//   - S02 ships 7 tools: render_mermaid, pin_mermaid, unpin_mermaid,
//     list_diagrams, get_diagram, delete_mermaid, search_diagrams.
//   - The R020 envelope on every tools/call result: success returns
//     {content: [{type:"text", text: JSON.stringify({...payload, elapsed_ms})}]};
//     failure returns {isError: true, content: [{type:"text", text:
//     JSON.stringify({code, message, retryable, elapsed_ms})}]}.
//   - The strict-404 contract (MEM014): delete_mermaid / pin_mermaid /
//     unpin_mermaid / get_diagram with an unknown id return
//     isError: true with code: -32005 (NOT idempotent — caller verifies
//     with list_diagrams first).
//   - Title round-trips: render_mermaid({title}) stores the title in the
//     entry, and search_diagrams({query}) returns the entry with
//     titleMatch: true when the query hits the title.
//
// Each test spawns a fresh src/server.mjs with MERMAID_RENDERER_DATA pointed
// at a per-test temp dir (created via os.tmpdir() + mkdtemp), so the real
// <repo>/data/ is never touched and parallel test runs do not collide.
// Cleanup in afterEach: close the child + rm the temp dir.
//
// Test inventory (11 it() blocks):
//   1. initialize handshake               (v0.1.0, unchanged)
//   2. lists 7 tools in tools/list        (UPDATED from v0.1.0's 1-tool list)
//   3. renders a diagram via tools/call   (UPDATED — adds title + elapsed_ms)
//   4. renders with title + search round-trip (S02, NEW)
//   5. pin_mermaid flips the pin flag     (S02, NEW)
//   6. unpin_mermaid is the dual          (S02, NEW)
//   7. list_diagrams paginates + pinned filter (S02, NEW)
//   8. get_diagram returns the full object (S02, NEW)
//   9. delete_mermaid removes entry + blob (S02, NEW)
//   10. search_diagrams titleMatch boost  (S02, NEW)
//   11. delete_mermaid 404 on missing id  (S02, NEW — strict 404 MEM014)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const EXPECTED_TOOL_NAMES_SORTED = [
	"delete_mermaid",
	"get_diagram",
	"list_diagrams",
	"pin_mermaid",
	"render_mermaid",
	"search_diagrams",
	"unpin_mermaid",
];
const VALID_GRAPH = "graph TD\n  A-->B";

/** Parse the single text item in a tools/call result.content[0] as JSON. */
function parseCallText(callResult) {
	expect(callResult).toBeDefined();
	expect(Array.isArray(callResult.content)).toBe(true);
	expect(callResult.content.length).toBeGreaterThan(0);
	const first = callResult.content[0];
	expect(first.type).toBe("text");
	expect(typeof first.text).toBe("string");
	return JSON.parse(first.text);
}

async function initialize(server) {
	return server.send("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

describe("stdio MCP integration", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-int-stdio-"));
		server = spawnServer({ env: { MERMAID_RENDERER_DATA: dataDir } });
	});

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// close() rejects in-flight sends on shutdown; safe to ignore in cleanup
			}
		}
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("completes the initialize handshake and reports serverInfo.name === 'mermaid-tui-mcp'", async () => {
		const result = await initialize(server);
		expect(result).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(result.serverInfo.name).toBe("mermaid-tui-mcp");
		// the version string is part of the contract — pin it to 0.1.0
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	});

	it("lists 7 tools in tools/list with the new CRUD surface", async () => {
		await initialize(server);
		const result = await server.send("tools/list", {});
		expect(result).toBeDefined();
		expect(Array.isArray(result.tools)).toBe(true);
		// S02 ships exactly 7 tools: 1 render + 6 resource management.
		expect(result.tools.length).toBe(7);
		expect(result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES_SORTED);
		// Every tool must carry a description and a JSON-schema inputSchema
		// (the latter is the S02 contract: LLM clients see a real schema,
		// not a zod object, per tools.mjs's z.toJSONSchema() call).
		for (const t of result.tools) {
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}
		// render_mermaid specifically still requires `code` (regression on
		// the v0.1.0 surface).
		const render = result.tools.find((t) => t.name === "render_mermaid");
		expect(render).toBeDefined();
		expect(Array.isArray(render.inputSchema.required)).toBe(true);
		expect(render.inputSchema.required).toContain("code");
	});

	it("renders a diagram via tools/call and returns { id, ascii, fileLink, title, elapsed_ms }", async () => {
		await initialize(server);
		const callResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH },
		});

		const parsed = parseCallText(callResult);

		// v0.1.0 success shape (preserved)
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
		expect(parsed.fileLink.endsWith(".html")).toBe(true);

		// S02 additions on the success envelope
		expect(parsed.title).toBe(""); // default when title is omitted
		expect(typeof parsed.elapsed_ms).toBe("number");
		expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("renders a diagram with a title and round-trips it through the storage entry", async () => {
		await initialize(server);

		// 1. render with title
		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "Auth flow" },
		});
		const rendered = parseCallText(renderResult);
		expect(rendered.title).toBe("Auth flow");
		expect(typeof rendered.id).toBe("string");
		expect(rendered.id.length).toBeGreaterThan(0);

		// 2. search by query and verify the title was indexed with titleMatch: true
		// (NOTE: list/search items don't carry id — it's the store map key.
		// We identify the entry by title, which is unique within this test.)
		const searchResult = await server.send("tools/call", {
			name: "search_diagrams",
			arguments: { query: "auth" },
		});
		const searchBody = parseCallText(searchResult);
		expect(Array.isArray(searchBody.items)).toBe(true);
		const hit = searchBody.items.find((e) => e.title === "Auth flow");
		expect(hit).toBeDefined();
		expect(hit.titleMatch).toBe(true);
		expect(hit.title).toBe("Auth flow");
	});

	it("pin_mermaid over stdio MCP flips the pinned flag and returns elapsed_ms", async () => {
		await initialize(server);

		// seed an id
		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "pin target" },
		});
		const id = parseCallText(renderResult).id;

		// pin
		const pinResult = await server.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id },
		});
		const pinned = parseCallText(pinResult);
		expect(pinned).toMatchObject({ id, pinned: true });
		expect(typeof pinned.elapsed_ms).toBe("number");
		expect(pinned.elapsed_ms).toBeGreaterThanOrEqual(0);

		// ground-truth: list_diagrams with pinned:true sees the entry
		// (NOTE: list items don't carry id — we identify by title, which is
		// unique within this test.)
		const listResult = await server.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(listBody.items.some((e) => e.title === "pin target" && e.pinned === true)).toBe(true);
	});

	it("unpin_mermaid over stdio MCP is the dual of pin_mermaid", async () => {
		await initialize(server);

		// seed + pin
		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "unpin target" },
		});
		const id = parseCallText(renderResult).id;

		await server.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id },
		});

		// unpin
		const unpinResult = await server.send("tools/call", {
			name: "unpin_mermaid",
			arguments: { id },
		});
		const unpinned = parseCallText(unpinResult);
		expect(unpinned).toMatchObject({ id, pinned: false });
		expect(typeof unpinned.elapsed_ms).toBe("number");
		expect(unpinned.elapsed_ms).toBeGreaterThanOrEqual(0);

		// ground-truth: list with pinned:true no longer sees it
		const listResult = await server.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(listBody.items.some((e) => e.title === "unpin target")).toBe(false);
	});

	it("list_diagrams over stdio MCP paginates with limit and supports pinned filter", async () => {
		await initialize(server);

		// render 3
		const r1 = parseCallText(
			await server.send("tools/call", {
				name: "render_mermaid",
				arguments: { code: VALID_GRAPH, title: "r1" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph LR\n  X-->Y", title: "r2" },
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph LR\n  M-->N", title: "r3" },
		});

		// 1. pagination: limit=2 of 3 → 2 items + a non-null nextCursor
		const pageResult = await server.send("tools/call", {
			name: "list_diagrams",
			arguments: { limit: 2 },
		});
		const page = parseCallText(pageResult);
		expect(Array.isArray(page.items)).toBe(true);
		expect(page.items).toHaveLength(2);
		expect(page.nextCursor).not.toBeNull();
		expect(typeof page.nextCursor).toBe("string");
		expect(typeof page.elapsed_ms).toBe("number");
		expect(page.elapsed_ms).toBeGreaterThanOrEqual(0);

		// 2. pinned filter: pin the first one rendered (r1) and verify it
		// shows up in pinned:true and the other 2 do not.
		// (NOTE: list items don't carry id — we identify by title, which is
		// unique within this test.)
		await server.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id: r1.id },
		});

		const pinnedList = parseCallText(
			await server.send("tools/call", {
				name: "list_diagrams",
				arguments: { pinned: true },
			}),
		);
		const pinnedTitles = pinnedList.items.map((e) => e.title);
		expect(pinnedTitles).toContain("r1");
		expect(pinnedTitles).not.toContain("r2");
		expect(pinnedTitles).not.toContain("r3");

		// and the unpinned filter excludes r1
		const unpinnedList = parseCallText(
			await server.send("tools/call", {
				name: "list_diagrams",
				arguments: { pinned: false },
			}),
		);
		const unpinnedTitles = unpinnedList.items.map((e) => e.title);
		expect(unpinnedTitles).not.toContain("r1");
		expect(unpinnedTitles).toContain("r2");
		expect(unpinnedTitles).toContain("r3");
	});

	it("get_diagram over stdio MCP returns the full object including title", async () => {
		await initialize(server);

		const title = "Get target";
		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title },
		});
		const id = parseCallText(renderResult).id;

		const getResult = await server.send("tools/call", {
			name: "get_diagram",
			arguments: { id },
		});
		const body = parseCallText(getResult);

		// S02 contract: get_diagram returns the full object {id, title, code,
		// ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength}.
		expect(body.id).toBe(id);
		expect(body.title).toBe(title);
		expect(body.code).toBe(VALID_GRAPH);
		expect(typeof body.ascii).toBe("string");
		// ascii is intentionally "" on a get (re-render would be a hidden
		// compute cost); LLM re-calls render_mermaid if it wants fresh ASCII.
		expect(body.ascii).toBe("");
		expect(typeof body.svg).toBe("string");
		expect(body.svg).toContain("<svg");
		expect(typeof body.createdAt).toBe("number");
		expect(typeof body.lastAccessedAt).toBe("number");
		expect(body.pinned).toBe(false);
		expect(body.sourceLength).toBe(VALID_GRAPH.length);
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("delete_mermaid over stdio MCP removes entry + blob and returns deleted: true", async () => {
		await initialize(server);

		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "delete target" },
		});
		const id = parseCallText(renderResult).id;

		// delete
		const delResult = await server.send("tools/call", {
			name: "delete_mermaid",
			arguments: { id },
		});
		const deleted = parseCallText(delResult);
		expect(deleted).toMatchObject({ id, deleted: true });
		expect(typeof deleted.elapsed_ms).toBe("number");
		expect(deleted.elapsed_ms).toBeGreaterThanOrEqual(0);

		// ground-truth: a follow-up get_diagram returns isError: true with
		// code: -32005 (strict 404, MEM014 — NOT idempotent).
		const followup = await server.send("tools/call", {
			name: "get_diagram",
			arguments: { id },
		});
		expect(followup.isError).toBe(true);
		const followupBody = parseCallText(followup);
		expect(followupBody.code).toBe(-32005);
		expect(followupBody.retryable).toBe(false);
	});

	it("search_diagrams over stdio MCP matches title with titleMatch boost", async () => {
		await initialize(server);

		// 3 renders: 2 titled, 1 untitled. All have "graph" in the code.
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "Alpha" },
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph LR\n  X-->Y", title: "Beta" },
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph LR\n  M-->N" }, // no title
		});

		// 1. title-match wins + ranks first
		const titleSearch = parseCallText(
			await server.send("tools/call", {
				name: "search_diagrams",
				arguments: { query: "alpha" },
			}),
		);
		expect(titleSearch.items.length).toBeGreaterThan(0);
		expect(titleSearch.items[0].title).toBe("Alpha");
		expect(titleSearch.items[0].titleMatch).toBe(true);
		expect(typeof titleSearch.elapsed_ms).toBe("number");
		expect(titleSearch.elapsed_ms).toBeGreaterThanOrEqual(0);

		// 2. code-only match returns at least one result with titleMatch: false
		const codeSearch = parseCallText(
			await server.send("tools/call", {
				name: "search_diagrams",
				arguments: { query: "graph" },
			}),
		);
		expect(codeSearch.items.length).toBeGreaterThan(0);
		// "graph" is not in any title (Alpha/Beta/""), so the top items
		// must carry titleMatch: false.
		expect(codeSearch.items.every((e) => e.titleMatch === false)).toBe(true);
		// The untitled entry was the newest (last render), so it should
		// appear first within the code-only tiebreak.
		expect(codeSearch.items[0].title).toBe("");
	});

	it("delete_mermaid over stdio MCP returns isError: true with code -32005 for a missing id (strict 404, MEM014)", async () => {
		await initialize(server);

		const result = await server.send("tools/call", {
			name: "delete_mermaid",
			arguments: { id: "nonexistent" },
		});
		expect(result.isError).toBe(true);

		const body = parseCallText(result);
		expect(body.code).toBe(-32005);
		expect(body.retryable).toBe(false);
		expect(typeof body.message).toBe("string");
		expect(body.message.length).toBeGreaterThan(0);
		// The R020 envelope still adds elapsed_ms on the failure path.
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	// ==========================================================================
	// S03 — zod -32602 surfaces in the inner CallToolResult payload (R020 + R008
	// + R010 + R009 path). The renderer's actual error is "mermaid source too
	// long (200001 chars, max 200000)" — the message must mention the length
	// and the max so the LLM sees the same hint eval-07 has asserted on.
	// ==========================================================================
	it("render_mermaid over stdio MCP returns isError: true with code -32602 for oversized code (eval-07 contract preserved through the S03 wrapper)", async () => {
		await initialize(server);

		const result = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "a".repeat(200_001) },
		});
		expect(result.isError).toBe(true);

		const body = parseCallText(result);
		// Inner-payload code is -32602 (InvalidParams), NOT the JSON-RPC envelope
		// -32602. Same number, different namespace — the namespace disambiguation
		// comment in src/errors.mjs documents this.
		expect(body.code).toBe(-32602);
		expect(body.retryable).toBe(false);
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
		// eval-07 substring contract: the message must mention both the actual
		// length and the max so an LLM can act on the diagnostic.
		expect(typeof body.message).toBe("string");
		expect(body.message).toContain("200001");
		expect(body.message).toContain("200000");
	});
});
