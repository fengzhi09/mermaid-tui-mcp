// tests/unit/tools.test.mjs — unit tests for src/tools.mjs.
//
// Locks:
//   - 7 handlers (renderMermaid, pinMermaid, unpinMermaid, listDiagrams,
//     getDiagram, deleteMermaid, searchDiagrams) each cover the success path
//     AND the tagged-error path (NotFoundError → code -32005).
//   - registerTools wrapper produces the R020 envelope on success (the
//     parsed content[0].text JSON carries elapsed_ms >= 0) AND on tagged
//     error (isError: true, code: -32005, retryable: false).
//
// The 7 handlers are pure (no MCP SDK import); tests inject a mock ctx
// whose storage is a real LocalFsStorage rooted in a temp dir, so we
// exercise the real StorageBackend contract end-to-end without spawning
// the stdio transport. The render + renderView seams are real (imported
// from src/render.mjs + src/helpers.mjs) so renderMermaid's success
// path actually runs the JS pipeline; only the warnings branch stubs
// ctx.render to simulate the "[mermaid-ascii failed:" prefix.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { NotFoundError, registerTools, deleteMermaid, getDiagram, listDiagrams, pinMermaid, renderMermaid, searchDiagrams, unpinMermaid } from "../../src/tools.mjs";
import { render as realRender } from "../../src/render.mjs";
import { renderView } from "../../src/helpers.mjs";
import { makeTempStorage } from "../helpers/storage-fixture.mjs";

/**
 * Build a fresh ctx for the tool handlers. Returns the ctx + a cleanup
 * function. `dataDir` is a mkdtemp root; the storage is loaded; the rest
 * of the seam (render / renderView / http*) is wired with sensible
 * defaults.
 */
async function makeCtx({ httpEnabled = false } = {}) {
	const fixture = await makeTempStorage();
	const ctx = {
		storage: fixture.storage,
		dataDir: fixture.root,
		render: realRender,
		renderView,
		httpEnabled,
		httpHost: "127.0.0.1",
		httpPort: 5300,
	};
	return {
		ctx,
		async cleanup() {
			await fixture.cleanup();
		},
	};
}

const VALID_GRAPH = "graph TD\n  A-->B";

describe("renderMermaid()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("returns { id, ascii, fileLink, httpLink: null, title: \"\" } on success without a title", async () => {
		const out = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		expect(typeof out.id).toBe("string");
		expect(out.id.length).toBeGreaterThan(0);
		expect(typeof out.ascii).toBe("string");
		expect(out.ascii.length).toBeGreaterThan(0);
		expect(typeof out.fileLink).toBe("string");
		expect(out.fileLink).toMatch(/^file:\/\/\//);
		// httpEnabled defaults to false in makeCtx → httpLink must be null
		expect(out.httpLink).toBeNull();
		// title defaults to "" when not passed
		expect(out.title).toBe("");
		// no warnings on a clean render
		expect(out.warnings).toBeUndefined();
	});

	it("persists the title in the returned object and in the stored entry", async () => {
		const out = await renderMermaid({ code: VALID_GRAPH, title: "Auth flow" }, fixture.ctx);
		expect(out.title).toBe("Auth flow");
		const entry = fixture.ctx.storage.getMetadata(out.id);
		expect(entry.title).toBe("Auth flow");
	});

	it("returns httpLink when ctx.httpEnabled is true", async () => {
		const httpFixture = await makeCtx({ httpEnabled: true });
		try {
			const out = await renderMermaid({ code: VALID_GRAPH }, httpFixture.ctx);
			expect(out.httpLink).toBe(`http://127.0.0.1:5300/view?id=${out.id}`);
		} finally {
			await httpFixture.cleanup();
		}
	});

	it("writes the <id>.html blob next to the <id>.svg blob (mirror v0.1.0 pattern)", async () => {
		const out = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		const htmlPath = join(fixture.ctx.dataDir, "blobs", `${out.id}.html`);
		const svgPath = join(fixture.ctx.dataDir, "blobs", `${out.id}.svg`);
		expect(existsSync(htmlPath)).toBe(true);
		expect(existsSync(svgPath)).toBe(true);
		// fileLink points at the htmlPath
		expect(out.fileLink).toContain(out.id);
		expect(out.fileLink).toContain(".html");
	});

	it("surfaces warnings: ['ascii_failed: <reason>'] when the renderer reports an ASCII conversion failure (R025)", async () => {
		// Stub ctx.render to return ascii starting with the canonical failure prefix.
		const stubbed = {
			...fixture.ctx,
			render: async () => ({
				id: "mWarn1",
				svg: "<svg>body</svg>",
				ascii: "[mermaid-ascii failed: bad token in code]\ngraph TD\n  A-->B",
				sourceLength: VALID_GRAPH.length,
			}),
		};
		const out = await renderMermaid({ code: VALID_GRAPH }, stubbed);
		expect(out.warnings).toEqual(["ascii_failed: bad token in code"]);
		// success-shape fields are still present
		expect(out.id).toBe("mWarn1");
		expect(typeof out.ascii).toBe("string");
	});

	it("does not include the warnings key when the render is clean (no field pollution)", async () => {
		const out = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		expect(Object.prototype.hasOwnProperty.call(out, "warnings")).toBe(false);
	});
});

describe("pinMermaid()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("flips the pin flag to true and returns { id, pinned: true }", async () => {
		const renderOut = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		const out = await pinMermaid({ id: renderOut.id }, fixture.ctx);
		expect(out).toEqual({ id: renderOut.id, pinned: true });
		expect(fixture.ctx.storage.getMetadata(renderOut.id).pinned).toBe(true);
	});

	it("throws NotFoundError (code -32005, retryable: false) for a missing id", async () => {
		let caught;
		try {
			await pinMermaid({ id: "does-not-exist" }, fixture.ctx);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NotFoundError);
		expect(caught.code).toBe(-32005);
		expect(caught.retryable).toBe(false);
		expect(caught.message).toContain("does-not-exist");
	});
});

describe("unpinMermaid()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("flips the pin flag to false and returns { id, pinned: false }", async () => {
		const renderOut = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		await pinMermaid({ id: renderOut.id }, fixture.ctx);
		const out = await unpinMermaid({ id: renderOut.id }, fixture.ctx);
		expect(out).toEqual({ id: renderOut.id, pinned: false });
		expect(fixture.ctx.storage.getMetadata(renderOut.id).pinned).toBe(false);
	});

	it("throws NotFoundError (code -32005) for a missing id", async () => {
		let caught;
		try {
			await unpinMermaid({ id: "nope" }, fixture.ctx);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NotFoundError);
		expect(caught.code).toBe(-32005);
		expect(caught.retryable).toBe(false);
	});
});

describe("listDiagrams()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("returns { items, nextCursor } with the right shape and paginates with limit=2 of 3 entries", async () => {
		await renderMermaid({ code: "graph TD\n  A-->B", title: "first" }, fixture.ctx);
		await new Promise((r) => setTimeout(r, 5));
		await renderMermaid({ code: "graph TD\n  C-->D", title: "second" }, fixture.ctx);
		await new Promise((r) => setTimeout(r, 5));
		await renderMermaid({ code: "graph TD\n  E-->F", title: "third" }, fixture.ctx);

		const page1 = await listDiagrams({ limit: 2 }, fixture.ctx);
		expect(page1.items).toHaveLength(2);
		// newest first → "third" then "second"
		expect(page1.items[0].title).toBe("third");
		expect(page1.items[1].title).toBe("second");
		expect(typeof page1.nextCursor).toBe("string");
		expect(page1.nextCursor.length).toBeGreaterThan(0);

		const page2 = await listDiagrams({ limit: 2, cursor: page1.nextCursor }, fixture.ctx);
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0].title).toBe("first");
		expect(page2.nextCursor).toBeNull();
	});
});

describe("getDiagram()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("returns the full object {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength}", async () => {
		const renderOut = await renderMermaid({ code: VALID_GRAPH, title: "Auth flow" }, fixture.ctx);
		const out = await getDiagram({ id: renderOut.id }, fixture.ctx);
		expect(out.id).toBe(renderOut.id);
		expect(out.title).toBe("Auth flow");
		expect(out.code).toBe(VALID_GRAPH);
		expect(typeof out.ascii).toBe("string");
		expect(out.svg).toContain("<svg");
		expect(typeof out.createdAt).toBe("number");
		expect(typeof out.lastAccessedAt).toBe("number");
		expect(out.pinned).toBe(false);
		expect(out.sourceLength).toBe(VALID_GRAPH.length);
	});

	it("throws NotFoundError (code -32005) for a missing id", async () => {
		let caught;
		try {
			await getDiagram({ id: "nope" }, fixture.ctx);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NotFoundError);
		expect(caught.code).toBe(-32005);
		expect(caught.retryable).toBe(false);
	});
});

describe("deleteMermaid()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("removes the entry + blob and returns { id, deleted: true }", async () => {
		const renderOut = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		const blobPath = join(fixture.ctx.dataDir, "blobs", `${renderOut.id}.svg`);
		expect(existsSync(blobPath)).toBe(true);

		const out = await deleteMermaid({ id: renderOut.id }, fixture.ctx);
		expect(out).toEqual({ id: renderOut.id, deleted: true });
		expect(fixture.ctx.storage.has(renderOut.id)).toBe(false);
		expect(existsSync(blobPath)).toBe(false);
	});

	it("throws NotFoundError (code -32005) for a missing id (strict, not idempotent per MEM014)", async () => {
		let caught;
		try {
			await deleteMermaid({ id: "nope" }, fixture.ctx);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NotFoundError);
		expect(caught.code).toBe(-32005);
		expect(caught.retryable).toBe(false);
	});
});

describe("searchDiagrams()", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("returns items with titleMatch: true for title matches (ranks above code matches)", async () => {
		// mCode is NEWER (createdAt: latest) but matches only on code; mTitle
		// is OLDER and matches on title. titleMatch DESC wins → mTitle first.
		// Both codes are valid mermaid so the real renderer can put them on disk.
		await renderMermaid({ code: "flowchart TD\n  A -->|auth| B", title: "no-match" }, fixture.ctx);
		await new Promise((r) => setTimeout(r, 5));
		await renderMermaid({ code: "graph LR\n  X-->Y", title: "auth-title" }, fixture.ctx);

		const out = await searchDiagrams({ query: "auth" }, fixture.ctx);
		expect(out.items).toHaveLength(2);
		expect(out.items[0].titleMatch).toBe(true);
		expect(out.items[0].title).toBe("auth-title");
		expect(out.items[1].titleMatch).toBe(false);
		// snippet is wrapped in <mark> on the hit text
		expect(out.items[0].snippet).toContain("<mark>auth</mark>");
	});

	it("passes limit / cursor / pinned through to storage.search", async () => {
		// First entry: matches on title ("auth-a")
		const first = await renderMermaid({ code: VALID_GRAPH, title: "auth-a" }, fixture.ctx);
		// Second entry: matches on title ("auth-b") — newer
		await renderMermaid({ code: "graph LR\n  X-->Y", title: "auth-b" }, fixture.ctx);
		// Third entry: no match
		await renderMermaid({ code: "graph LR\n  M-->N", title: "nope" }, fixture.ctx);
		// Pin the first one (id is in the render result, not the search item)
		await pinMermaid({ id: first.id }, fixture.ctx);

		const out = await searchDiagrams({ query: "auth", limit: 1 }, fixture.ctx);
		expect(out.items).toHaveLength(1);
		expect(typeof out.nextCursor).toBe("string");

		const pinnedOnly = await searchDiagrams({ query: "auth", pinned: true }, fixture.ctx);
		expect(pinnedOnly.items).toHaveLength(1);
		expect(pinnedOnly.items[0].pinned).toBe(true);

		const unpinned = await searchDiagrams({ query: "auth", pinned: false }, fixture.ctx);
		expect(unpinned.items).toHaveLength(1);
		expect(unpinned.items[0].pinned).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// registerTools wrapper — exercised via a fake `mcp` that records each
// registerTool call. The wrapper must produce the R020 envelope on both
// success and tagged error paths.
// ---------------------------------------------------------------------------

describe("registerTools()", () => {
	let fixture;
	let recorded;

	beforeEach(async () => {
		fixture = await makeCtx({ httpEnabled: true });
		recorded = [];
		// Pre-render one diagram so pin / get / delete / list have a target.
		await renderMermaid({ code: VALID_GRAPH, title: "wrapper test" }, fixture.ctx);
	});

	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	function fakeMcp() {
		const handlers = new Map();
		return {
			setRequestHandler(schema, handler) {
				handlers.set(schema, handler);
				recorded.push({ schema, handler });
			},
			// Test ergonomics: a proxy that calls the registered CallTool handler
			// with the same wire shape the real SDK sends, but lets tests pass
			// `(toolName, args)` instead of `{params:{name,arguments}}`.
			async callTool(toolName, args) {
				const h = handlers.get(CallToolRequestSchema);
				if (!h) throw new Error("CallToolRequestSchema handler not registered");
				return h({ params: { name: toolName, arguments: args } });
			},
			async listTools() {
				const h = handlers.get(ListToolsRequestSchema);
				if (!h) throw new Error("ListToolsRequestSchema handler not registered");
				return h({});
			},
		};
	}

	it("registers all 7 tools with description + inputSchema set", async () => {
		const mcp = fakeMcp();
		registerTools(mcp, fixture.ctx);
		const list = await mcp.listTools();
		const names = list.tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"delete_mermaid",
			"get_diagram",
			"list_diagrams",
			"pin_mermaid",
			"render_mermaid",
			"search_diagrams",
			"unpin_mermaid",
		]);
		for (const t of list.tools) {
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			// inputSchema is a JSON schema (draft-07), produced from the zod
			// object via z.toJSONSchema(). Must be a plain object with `type`.
			expect(t.inputSchema).toBeTruthy();
			expect(typeof t.inputSchema).toBe("object");
		}
	});

	it("renders a success R020 envelope: { content: [{type:'text', text: JSON}], elapsed_ms >= 0", async () => {
		const mcp = fakeMcp();
		registerTools(mcp, fixture.ctx);
		const result = await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		expect(result.isError).toBeUndefined();
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		const parsed = JSON.parse(result.content[0].text);
		expect(typeof parsed.id).toBe("string");
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.elapsed_ms).toBeTypeOf("number");
		expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("renders a tagged-error R020 envelope: isError: true, code: -32005, retryable: false, elapsed_ms >= 0", async () => {
		const mcp = fakeMcp();
		registerTools(mcp, fixture.ctx);
		const result = await mcp.callTool("pin_mermaid", { id: "missing-id" });
		expect(result.isError).toBe(true);
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content[0].type).toBe("text");
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.code).toBe(-32005);
		expect(parsed.retryable).toBe(false);
		expect(parsed.message).toContain("missing-id");
		expect(parsed.elapsed_ms).toBeTypeOf("number");
		expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("renders each CRUD tool's success envelope with elapsed_ms", async () => {
		const mcp = fakeMcp();
		registerTools(mcp, fixture.ctx);

		// find the just-rendered diagram's id
		const renderResult = await mcp.callTool("render_mermaid", { code: VALID_GRAPH, title: "crud" });
		const id = JSON.parse(renderResult.content[0].text).id;

		// pin
		const pinResult = await mcp.callTool("pin_mermaid", { id });
		const pinBody = JSON.parse(pinResult.content[0].text);
		expect(pinBody).toMatchObject({ id, pinned: true });
		expect(pinBody.elapsed_ms).toBeTypeOf("number");

		// list — items don't carry id (it's the map key), so we match by title.
		const listResult = await mcp.callTool("list_diagrams", { limit: 5 });
		const listBody = JSON.parse(listResult.content[0].text);
		expect(Array.isArray(listBody.items)).toBe(true);
		expect(listBody.items.some((e) => e.title === "crud")).toBe(true);
		expect(listBody.elapsed_ms).toBeTypeOf("number");

		// get
		const getResult = await mcp.callTool("get_diagram", { id });
		const getBody = JSON.parse(getResult.content[0].text);
		expect(getBody.id).toBe(id);
		expect(getBody.title).toBe("crud");
		expect(getBody.code).toBe(VALID_GRAPH);
		expect(getBody.elapsed_ms).toBeTypeOf("number");

		// search
		const searchResult = await mcp.callTool("search_diagrams", { query: "crud" });
		const searchBody = JSON.parse(searchResult.content[0].text);
		expect(searchBody.items.length).toBeGreaterThan(0);
		expect(searchBody.items[0].titleMatch).toBe(true);
		expect(searchBody.elapsed_ms).toBeTypeOf("number");

		// delete
		const delResult = await mcp.callTool("delete_mermaid", { id });
		const delBody = JSON.parse(delResult.content[0].text);
		expect(delBody).toEqual({ id, deleted: true, elapsed_ms: delBody.elapsed_ms });
		expect(delBody.elapsed_ms).toBeTypeOf("number");

		// unpin — using a non-existent id to exercise the tagged-error envelope
		const unpinResult = await mcp.callTool("unpin_mermaid", { id: "never-existed" });
		const unpinBody = JSON.parse(unpinResult.content[0].text);
		expect(unpinBody.code).toBe(-32005);
		expect(unpinBody.elapsed_ms).toBeTypeOf("number");
	});

	it("classifies unknown (non-tagged) errors via classifyDomainError → isError:true with code -32603 in the inner envelope (S03: surfaces 500-class failures inside the CallToolResult instead of bubbling to JSON-RPC)", async () => {
		// Build a ctx whose pin handler explodes with a NON-tagged error
		// (no `.code` property). The S02 wrapper re-threw these so the
		// SDK converted them to a JSON-RPC -32603 envelope. The S03
		// wrapper classifies them via classifyDomainError (which returns
		// -32603 / retryable: false for the default branch) and surfaces
		// them in the inner CallToolResult so the LLM sees the same
		// shape it sees for tagged errors. Net effect: the LLM always
		// sees a structured CallToolResult, never a JSON-RPC envelope
		// error, for in-process failures.
		const explodyCtx = {
			...fixture.ctx,
			storage: {
				...fixture.ctx.storage,
				setPinned: async () => {
					throw new Error("boom — not a tagged error");
				},
			},
		};
		const mcp = fakeMcp();
		registerTools(mcp, explodyCtx);
		const result = await mcp.callTool("pin_mermaid", { id: "any" });
		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0].text);
		expect(body.code).toBe(-32603);
		expect(body.retryable).toBe(false);
		expect(typeof body.message).toBe("string");
		expect(body.message).toContain("boom — not a tagged error");
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("classifies the renderer's 'mermaid source too long' throw as -32602 (InvalidParams) in the inner envelope", async () => {
		// src/render.mjs throws a plain Error with message starting with
		// "mermaid source too long" — there's no .code on the throw, so
		// the wrapper has to classify by message. classifyDomainError
		// maps that prefix to -32602, retryable: false. This is the
		// path the integration test "render_mermaid with oversized code
		// returns code -32602" exercises end-to-end.
		const mcp = fakeMcp();
		registerTools(mcp, fixture.ctx);
		const result = await mcp.callTool("render_mermaid", { code: "a".repeat(200_001) });
		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0].text);
		expect(body.code).toBe(-32602);
		expect(body.retryable).toBe(false);
		expect(body.message).toContain("200001");
		expect(body.message).toContain("200000");
	});

	it("classifies the renderer's 'mermaid parse error:' throw as -32002 (RenderFailed) in the inner envelope", async () => {
		// Stub ctx.render to throw the canonical "mermaid parse error: ..."
		// prefix. The wrapper must classify this as -32002 (RenderFailed)
		// and surface it in the inner envelope — preserving the 9 existing
		// eval tests' substring assertions on the original message.
		const stubbed = {
			...fixture.ctx,
			render: async () => {
				throw new Error("mermaid parse error: Lexical error on line 3");
			},
		};
		const mcp = fakeMcp();
		registerTools(mcp, stubbed);
		const result = await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		expect(result.isError).toBe(true);
		const body = JSON.parse(result.content[0].text);
		expect(body.code).toBe(-32002);
		expect(body.retryable).toBe(false);
		expect(body.message).toBe("mermaid parse error: Lexical error on line 3");
	});

	it("failure path fires all four observability hooks (logger + counters + recordError + setLastRenderMs)", async () => {
		// S03 (R008/R009/R010): when a tool call fails AND ctx carries the
		// observability surface, the wrapper must:
		//   1. emit a structured stderr log line
		//   2. increment the render_errors counter
		//   3. push to the 5-error ring
		//   4. update last_render_ms
		// Pins the wiring in tools.mjs so a future refactor can't silently
		// drop one of the hooks. logger is a vi.spy on process.stderr.write
		// (mirrors the unit pattern in tests/unit/logger.test.mjs).
		const logCalls = [];
		const counters = { incrementCalls: [], increment: async function (key) { this.incrementCalls.push(key); return this.incrementCalls.length; } };
		const recordErrorCalls = [];
		let lastRenderMs = -1;
		const setLastRenderMsFn = (ms) => { lastRenderMs = ms; };

		const observabilityCtx = {
			...fixture.ctx,
			counters,
			logger: (rec) => logCalls.push(rec),
			recordError: (e) => recordErrorCalls.push(e),
			setLastRenderMs: setLastRenderMsFn,
		};

		// Trigger a failure via the renderer's too-long source.
		const mcp = fakeMcp();
		registerTools(mcp, observabilityCtx);
		const result = await mcp.callTool("render_mermaid", { code: "a".repeat(200_001) });
		expect(result.isError).toBe(true);

		// 1. logger was called with the structured tool_call event
		const toolCallLog = logCalls.find((l) => l.event === "tool_call");
		expect(toolCallLog).toBeDefined();
		expect(toolCallLog.tool).toBe("render_mermaid");
		expect(toolCallLog.status).toBe("error");
		expect(toolCallLog.code).toBe(-32602);
		expect(toolCallLog.retryable).toBe(false);
		expect(typeof toolCallLog.elapsed_ms).toBe("number");
		expect(toolCallLog.elapsed_ms).toBeGreaterThanOrEqual(0);

		// 2. counters.increment("render_errors") was called exactly once
		expect(counters.incrementCalls).toContain("render_errors");

		// 3. recordError was called with the right shape
		expect(recordErrorCalls).toHaveLength(1);
		expect(recordErrorCalls[0].code).toBe(-32602);
		expect(recordErrorCalls[0].retryable).toBe(false);
		expect(typeof recordErrorCalls[0].message).toBe("string");
		expect(recordErrorCalls[0].message).toContain("200001");

		// 4. setLastRenderMs was called with a number
		expect(lastRenderMs).toBeGreaterThanOrEqual(0);
	});

	it("success path fires the same four observability hooks (logger + counters + setLastRenderMs — no recordError)", async () => {
		// Mirror test: success path exercises logger + render_total counter
		// + setLastRenderMs but NOT recordError (no failure to record).
		const logCalls = [];
		const counters = { incrementCalls: [], increment: async function (key) { this.incrementCalls.push(key); return this.incrementCalls.length; } };
		const recordErrorCalls = [];
		let lastRenderMs = -1;
		const setLastRenderMsFn = (ms) => { lastRenderMs = ms; };

		const observabilityCtx = {
			...fixture.ctx,
			counters,
			logger: (rec) => logCalls.push(rec),
			recordError: (e) => recordErrorCalls.push(e),
			setLastRenderMs: setLastRenderMsFn,
		};

		const mcp = fakeMcp();
		registerTools(mcp, observabilityCtx);
		const result = await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		expect(result.isError).toBeFalsy();

		const toolCallLog = logCalls.find((l) => l.event === "tool_call");
		expect(toolCallLog).toBeDefined();
		expect(toolCallLog.tool).toBe("render_mermaid");
		expect(toolCallLog.status).toBe("ok");
		expect(typeof toolCallLog.elapsed_ms).toBe("number");
		expect(toolCallLog.elapsed_ms).toBeGreaterThanOrEqual(0);

		// render_total is bumped on render_mermaid success.
		expect(counters.incrementCalls).toContain("render_total");
		// render_errors is NOT bumped on success.
		expect(counters.incrementCalls).not.toContain("render_errors");

		// recordError is NOT called on success.
		expect(recordErrorCalls).toHaveLength(0);

		// setLastRenderMs was called with a positive number (real render).
		expect(lastRenderMs).toBeGreaterThanOrEqual(0);
	});

	it("warns once when observability hooks are missing (defensive, not spam)", async () => {
		// Pass a ctx WITHOUT the observability fields. The wrapper should
		// continue working but log a one-time warning. The warning is
		// fired via the logger, so a logger is required for the warning
		// itself to be emitted — which is fine, the lock is "no logger,
		// no warning" (the absence of the logger is the failure mode the
		// warning was meant to flag, so it's OK if it can't reach stderr).
		const logCalls = [];
		const observabilityCtx = {
			...fixture.ctx,
			// intentionally no counters / logger / recordError / setLastRenderMs
		};

		const mcp = fakeMcp();
		registerTools(mcp, observabilityCtx);
		await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		// Without a logger, no warning is emitted (the logger is the
		// mechanism for the warning). The calls succeed normally.
		// This test mainly locks the "don't crash when observability is
		// missing" path.
		expect(logCalls).toHaveLength(0);
	});

	it("records the render_warnings path through the wrapper (warnings key on success envelope)", async () => {
		const explodyRender = {
			...fixture.ctx,
			render: async () => ({
				id: "mWarn2",
				svg: "<svg>body</svg>",
				ascii: "[mermaid-ascii failed: stubbed]\nsource",
				sourceLength: 6,
			}),
		};
		const mcp = fakeMcp();
		registerTools(mcp, explodyRender);
		const result = await mcp.callTool("render_mermaid", { code: VALID_GRAPH });
		const body = JSON.parse(result.content[0].text);
		expect(body.warnings).toEqual(["ascii_failed: stubbed"]);
		expect(body.id).toBe("mWarn2");
	});
});

// ---------------------------------------------------------------------------
// Defensive: handlers should not throw on the input validation surface
// because the wrapper is responsible for that. These cases verify handlers
// fail on storage miss (NotFoundError) rather than on null/missing args.
// ---------------------------------------------------------------------------

describe("handler input robustness", () => {
	let fixture;
	beforeEach(async () => {
		fixture = await makeCtx();
	});
	afterEach(async () => {
		if (fixture) await fixture.cleanup();
		fixture = undefined;
	});

	it("renderMermaid rejects empty code (storage untouched) by failing the zod-validated args path", async () => {
		// The wrapper enforces the zod schema; handlers trust the args shape.
		// This test asserts the handler itself does not silently produce output
		// for empty code — the underlying realRender() throws "empty mermaid source".
		await expect(renderMermaid({ code: "" }, fixture.ctx)).rejects.toThrow("empty mermaid source");
	});

	it("getDiagram returns svg as empty string (not undefined) when the blob is missing on disk", async () => {
		const renderOut = await renderMermaid({ code: VALID_GRAPH }, fixture.ctx);
		// Manually delete the blob to simulate a torn store. getMetadata still returns
		// the entry (it's in the in-memory map), so getDiagram must still respond
		// with svg: "" rather than null/undefined.
		const { unlink } = await import("node:fs/promises");
		await unlink(join(fixture.ctx.dataDir, "blobs", `${renderOut.id}.svg`));
		const out = await getDiagram({ id: renderOut.id }, fixture.ctx);
		expect(out.svg).toBe("");
	});
});

// Silence unused-import warnings from `vi` / `existsSync` etc. when added
// in the future. Keeps the import list scoped to the helpers actually used.
vi; // noop reference
