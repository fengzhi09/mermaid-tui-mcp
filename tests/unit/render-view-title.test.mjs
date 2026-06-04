// tests/unit/render-view-title.test.mjs — renderView {{TITLE}} / {{TITLE_JSON}} substitution.
//
// R023 requires the title surface (h1 + document.title + const TITLE = …) to be
// safe against HTML/JS injection. helpers.mjs feeds {{TITLE}} through escapeHtml
// (XSS guard for the visible <h1> and <title>) and {{TITLE_JSON}} through
// JSON.stringify (safe for the <script>-block const). These five cases lock that
// behavior for v0.2.0 and act as a regression net if a future refactor drops
// the escape on either pipe.

import { describe, expect, it } from "vitest";

import { escapeHtml, renderView } from "../../src/helpers.mjs";

// Minimal entry fixture — only the fields renderView actually touches.
function makeEntry(overrides = {}) {
	return {
		code: "graph TD\n  A-->B",
		createdAt: 1_700_000_000_000,
		pinned: false,
		lastAccessedAt: 1_700_000_000_000,
		sourceLength: 13,
		...overrides,
	};
}

describe("renderView {{TITLE}} substitution", () => {
	it("substitutes {{TITLE}} with the escaped title when entry.title is set", async () => {
		const entry = makeEntry({ title: "Auth flow" });
		const html = await renderView("t01", entry, "<svg></svg>", false);

		// the escaped title is present in the rendered HTML
		expect(html).toContain("Auth flow");
		// the raw {{TITLE}} placeholder is gone
		expect(html).not.toContain("{{TITLE}}");
		// the title lands in the h1 slot
		expect(html).toMatch(/<h1 class="diagram-title" id="diagram-title">Auth flow<\/h1>/);
		// and in the <title> element
		expect(html).toMatch(/<title>Auth flow · Mermaid t01<\/title>/);
	});

	it("escapes HTML in the title (XSS guard)", async () => {
		const entry = makeEntry({ title: "<script>alert(1)</script>" });
		const html = await renderView("xss1", entry, "<svg></svg>", false);

		// the escaped form must appear
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

		// The raw <script>alert(1)</script> substring MUST NOT appear in the
		// HTML context. It will appear inside the <script> block via
		// {{TITLE_JSON}} (JSON.stringify of the title) — that is safe because
		// it's a JS string value, not an HTML element.
		//
		// We can't use a single regex like /<script[\s\S]*?<\/script>/g to
		// strip the script block because that regex also matches the
		// JSON-stringified form of the title itself (which is itself shaped
		// like <script>...</script>). Instead, locate the actual <script>
		// block boundaries by index — view.html only has one inline script
		// block, and the first <script> opening tag is always it (the
		// <script> inside the JSON form is preceded by a quote, not by a
		// tag boundary).
		const firstScriptOpen = html.indexOf("<script>");
		const lastScriptClose = html.lastIndexOf("</script>");
		expect(firstScriptOpen).toBeGreaterThan(-1);
		expect(lastScriptClose).toBeGreaterThan(firstScriptOpen);
		const htmlOutsideScripts =
			html.slice(0, firstScriptOpen) + html.slice(lastScriptClose + "</script>".length);
		expect(htmlOutsideScripts).not.toContain("<script>alert(1)</script>");
		expect(htmlOutsideScripts).not.toContain("</script>");
		// The h1 contains the escaped form, not the raw one.
		expect(html).toMatch(
			/<h1 class="diagram-title" id="diagram-title">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/,
		);
	});

	it("substitutes {{TITLE}} with an empty string when entry.title is missing or empty", async () => {
		const htmlEmpty = await renderView("t03a", makeEntry({ title: "" }), "<svg></svg>", false);
		const htmlUndef = await renderView("t03b", makeEntry({ title: undefined }), "<svg></svg>", false);

		for (const html of [htmlEmpty, htmlUndef]) {
			// raw placeholder is gone
			expect(html).not.toContain("{{TITLE}}");
			// h1 slot is present but empty (so .diagram-title:empty { display: none } hides it)
			expect(html).toMatch(/<h1 class="diagram-title" id="diagram-title"><\/h1>/);
		}

		// {{TITLE_JSON}} resolves to JSON.stringify("") === '""' in both cases
		expect(htmlEmpty).toContain('const TITLE = "";');
		expect(htmlUndef).toContain('const TITLE = "";');
	});
});

describe("renderView {{TITLE_JSON}} substitution", () => {
	it("substitutes {{TITLE_JSON}} with the JSON-stringified title for JS-side use", async () => {
		const entry = makeEntry({ title: 'He said "hi"' });
		const html = await renderView("t04", entry, "<svg></svg>", false);

		// JSON.stringify('He said "hi"') === '"He said \\"hi\\""' which the
		// raw HTML carries as: const TITLE = "He said \"hi\"";
		expect(html).toContain('const TITLE = "He said \\"hi\\"";');
		// the <script>-block const TITLE line is the only place {{TITLE_JSON}}
		// lands, so the raw placeholder must be gone
		expect(html).not.toContain("{{TITLE_JSON}}");
	});
});

describe("renderView {{TITLE}} does not regress {{ID}} or {{CODE}} substitution", () => {
	it("preserves the {{ID}} and {{CODE}} placeholder substitution when {{TITLE}} is set", async () => {
		const entry = makeEntry({ title: "Diagram" });
		const html = await renderView("regr1", entry, "<svg><g/></svg>", true);

		// {{ID}} is gone (substituted) — visible form
		expect(html).not.toContain("{{ID}}");
		// {{CODE}} is gone (substituted) — code block lands in <pre>
		expect(html).not.toContain("{{CODE}}");
		// {{TITLE}} is also gone
		expect(html).not.toContain("{{TITLE}}");
		// {{ID_JSON}}, {{TITLE_JSON}}, {{WITH_PIN}} are all gone
		expect(html).not.toContain("{{ID_JSON}}");
		expect(html).not.toContain("{{TITLE_JSON}}");
		expect(html).not.toContain("{{WITH_PIN}}");
		// sanity: id and code are actually present
		expect(html).toContain("regr1");
		expect(html).toContain(escapeHtml(entry.code));
		// the SVG body survived
		expect(html).toContain("<g/>");
	});
});
