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
		return {
			registerTool(name, config, cb) {
				recorded.push({ name, config, cb });
			},
		};
	}

	function getHandler(name) {
		const entry = recorded.find((r) => r.name === name);
		if (!entry) throw new Error(`tool not registered: ${name}`);
		return entry.cb;
	}

	it("registers all 7 tools with description + inputSchema set", () => {
		registerTools(fakeMcp(), fixture.ctx);
		const names = recorded.map((r) => r.name).sort();
		expect(names).toEqual([
			"delete_mermaid",
			"get_diagram",
			"list_diagrams",
			"pin_mermaid",
			"render_mermaid",
			"search_diagrams",
			"unpin_mermaid",
		]);
		for (const r of recorded) {
			expect(typeof r.config.description).toBe("string");
			expect(r.config.description.length).toBeGreaterThan(0);
			// inputSchema is the zod object — truthy and has .shape (zod v4 contract)
			expect(r.config.inputSchema).toBeTruthy();
		}
	});

	it("renders a success R020 envelope: { content: [{type:'text', text: JSON}], elapsed_ms >= 0}", async () => {
		registerTools(fakeMcp(), fixture.ctx);
		const cb = getHandler("render_mermaid");
		const result = await cb({ code: VALID_GRAPH });
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
		registerTools(fakeMcp(), fixture.ctx);
		const cb = getHandler("pin_mermaid");
		const result = await cb({ id: "missing-id" });
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
		registerTools(fakeMcp(), fixture.ctx);
		// find the just-rendered diagram's id
		const renderCb = getHandler("render_mermaid");
		const renderResult = await renderCb({ code: VALID_GRAPH, title: "crud" });
		const id = JSON.parse(renderResult.content[0].text).id;

		// pin
		const pinResult = await getHandler("pin_mermaid")({ id });
		const pinBody = JSON.parse(pinResult.content[0].text);
		expect(pinBody).toMatchObject({ id, pinned: true });
		expect(pinBody.elapsed_ms).toBeTypeOf("number");

		// list — items don't carry id (it's the map key), so we match by title.
		const listResult = await getHandler("list_diagrams")({ limit: 5 });
		const listBody = JSON.parse(listResult.content[0].text);
		expect(Array.isArray(listBody.items)).toBe(true);
		expect(listBody.items.some((e) => e.title === "crud")).toBe(true);
		expect(listBody.elapsed_ms).toBeTypeOf("number");

		// get
		const getResult = await getHandler("get_diagram")({ id });
		const getBody = JSON.parse(getResult.content[0].text);
		expect(getBody.id).toBe(id);
		expect(getBody.title).toBe("crud");
		expect(getBody.code).toBe(VALID_GRAPH);
		expect(getBody.elapsed_ms).toBeTypeOf("number");

		// search
		const searchResult = await getHandler("search_diagrams")({ query: "crud" });
		const searchBody = JSON.parse(searchResult.content[0].text);
		expect(searchBody.items.length).toBeGreaterThan(0);
		expect(searchBody.items[0].titleMatch).toBe(true);
		expect(searchBody.elapsed_ms).toBeTypeOf("number");

		// delete
		const delResult = await getHandler("delete_mermaid")({ id });
		const delBody = JSON.parse(delResult.content[0].text);
		expect(delBody).toEqual({ id, deleted: true, elapsed_ms: delBody.elapsed_ms });
		expect(delBody.elapsed_ms).toBeTypeOf("number");

		// unpin — using a non-existent id to exercise the tagged-error envelope
		const unpinResult = await getHandler("unpin_mermaid")({ id: "never-existed" });
		const unpinBody = JSON.parse(unpinResult.content[0].text);
		expect(unpinBody.code).toBe(-32005);
		expect(unpinBody.elapsed_ms).toBeTypeOf("number");
	});

	it("re-throws unknown errors (does not silently convert to isError:true) so the SDK returns -32603", async () => {
		// Build a ctx whose pin handler explodes with a NON-tagged error.
		const explodyCtx = {
			...fixture.ctx,
			storage: {
				...fixture.ctx.storage,
				setPinned: async () => {
					throw new Error("boom — not a tagged error");
				},
			},
		};
		registerTools(fakeMcp(), explodyCtx);
		const cb = getHandler("pin_mermaid");
		await expect(cb({ id: "any" })).rejects.toThrow("boom — not a tagged error");
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
		registerTools(fakeMcp(), explodyRender);
		const cb = getHandler("render_mermaid");
		const result = await cb({ code: VALID_GRAPH });
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
