// tests/unit/server-helpers.test.mjs — unit tests for src/helpers.mjs.
//
// The six pure helpers (escapeHtml, fileUrlFor, extractSvgBody, httpError,
// renderView, log) were extracted from src/server.mjs in T02 so they can
// be unit-tested in isolation. Importing server.mjs would run its mainline
// bootstrap (Storage instantiation, `await storage.load()`, stdio MCP
// connect) and pollute the repo with a `data/` directory — out of scope
// for a unit test, and that's what the integration tests in T03 cover.

import { describe, expect, it, vi } from "vitest";

import { escapeHtml, extractSvgBody, fileUrlFor, httpError, log, renderView } from "../../src/helpers.mjs";

describe("escapeHtml", () => {
	it("escapes &, <, >, \", and '", () => {
		expect(escapeHtml("a&b")).toBe("a&amp;b");
		expect(escapeHtml("<x>")).toBe("&lt;x&gt;");
		expect(escapeHtml(`"q"`)).toBe("&quot;q&quot;");
		expect(escapeHtml("it's")).toBe("it&#39;s");
	});

	it("returns an unchanged string for inputs that need no escaping", () => {
		expect(escapeHtml("hello world")).toBe("hello world");
		expect(escapeHtml("")).toBe("");
	});
});

describe("fileUrlFor", () => {
	it("produces file:///abs for posix absolute paths", () => {
		expect(fileUrlFor("/Users/foo/bar.svg")).toBe("file:///Users/foo/bar.svg");
		expect(fileUrlFor("/var/log/x.log")).toBe("file:///var/log/x.log");
	});

	it("converts windows backslashes to forward slashes and prefixes with file:///", () => {
		expect(fileUrlFor("C:\\foo\\bar.svg")).toBe("file:///C:/foo/bar.svg");
		expect(fileUrlFor("D:\\nested\\path\\file.txt")).toBe("file:///D:/nested/path/file.txt");
	});
});

describe("extractSvgBody", () => {
	it("returns the inner content of a <svg>...</svg> block", () => {
		expect(extractSvgBody("<svg id=x>inner</svg>")).toBe("inner");
		expect(extractSvgBody("<svg viewBox=\"0 0 10 10\"><g><rect/></g></svg>")).toBe("<g><rect/></g>");
	});

	it("returns '' for input with no svg", () => {
		expect(extractSvgBody("hello world")).toBe("");
		expect(extractSvgBody("<div>nope</div>")).toBe("");
	});
});

describe("httpError", () => {
	it("returns an Error with .status and .message set", () => {
		const e = httpError(404, "not found");
		expect(e).toBeInstanceOf(Error);
		expect(e.status).toBe(404);
		expect(e.message).toBe("not found");
	});

	it("preserves arbitrary status codes (not just 4xx)", () => {
		expect(httpError(500, "boom").status).toBe(500);
		expect(httpError(418, "teapot").status).toBe(418);
	});
});

describe("renderView", () => {
	it("substitutes the {{ID}}, {{CREATED_AT}}, {{SVG_BODY}} placeholders in public/view.html", async () => {
		const id = "mTest1";
		const entry = {
			code: "graph TD\n  A-->B",
			createdAt: 1_700_000_000_000,
			pinned: false,
			lastAccessedAt: 1_700_000_000_000,
			sourceLength: 13,
		};
		const svg = "<svg id=mermaid-svg>body</svg>";
		const html = await renderView(id, entry, svg, /*withPinButton=*/true);

		expect(html).toContain(escapeHtml(id));
		expect(html).toContain(new Date(entry.createdAt).toISOString());
		expect(html).toContain("body");

		// the raw placeholders are gone (rendered view never leaks the template tokens)
		expect(html).not.toContain("{{ID}}");
		expect(html).not.toContain("{{CREATED_AT}}");
		expect(html).not.toContain("{{SVG_BODY}}");
	});

	it("html-escapes the id in title/span and JSON-escapes it inside the inline <script>", async () => {
		const id = "<script>alert(1)</script>";
		const entry = {
			code: "code&with<bad>\"chars'",
			createdAt: 1_700_000_000_000,
			pinned: true,
			lastAccessedAt: 1_700_000_000_000,
			sourceLength: 21,
		};
		const html = await renderView(id, entry, "<svg></svg>", false);

		// html-escaped id appears (in <title> and <span class="id"> via {{ID}})
		expect(html).toContain(escapeHtml(id));
		// json-escaped id appears inside the inline <script> (via {{ID_JSON}})
		expect(html).toContain(JSON.stringify(id));
		// html-escaped code appears (in <pre> via {{CODE}})
		expect(html).toContain(escapeHtml(entry.code));
		// the raw unescaped form must not appear in the html context (only inside
		// the JS string literal, which is bounded by quotes).
		// Specifically: <title>...</title> and <span class="id">...</span> both
		// use the escaped form. We check the <title> here.
		expect(html).toMatch(/<title>Mermaid &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
	});
});

describe("log", () => {
	it("writes a stderr line with the [HH:MM:SS][mermaid-renderer] prefix", () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			log("hello", 42, { a: 1 });
			expect(spy).toHaveBeenCalledTimes(1);
			const call = spy.mock.calls[0];
			// first arg is the prefix, then the original args
			expect(call[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\]\[mermaid-renderer\]$/);
			expect(call[1]).toBe("hello");
			expect(call[2]).toBe(42);
			expect(call[3]).toEqual({ a: 1 });
		} finally {
			spy.mockRestore();
		}
	});
});
