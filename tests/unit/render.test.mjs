// tests/unit/render.test.mjs — unit tests for src/render.mjs.
//
// Covers the input-validation surface (empty / whitespace / non-string /
// oversize), the happy path (returns { id, svg, ascii, sourceLength,
// asciiFailed }), the parse-error path, and the asciiFailed flag (R025
// sentinel). Uses VALID_GRAPH + MALFORMED from
// tests/helpers/render-fixture.mjs so the contract is shared with the
// eval tests (T04).
//
// M004: dropped the render timeout (R015) and jsdom init retry (R018)
// describe blocks. Synchronous beautiful-mermaid has no timeout path;
// no jsdom → no init retry path. The seam tests for those scenarios no
// longer apply.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED, VALID_GRAPH, oversizedCode } from "../helpers/render-fixture.mjs";
import { __setRenderImplForTesting, render } from "../../src/render.mjs";

// vi.hoisted: state shared with the vi.mock factory below. The factory is
// called during the import phase (before this file's top-level `let`s run),
// so the flag must live in a hoisted scope to avoid a TDZ ReferenceError.
const asciiMock = vi.hoisted(() => ({ shouldThrow: false }));

// Replace beautiful-mermaid with a thin wrapper around the real module.
// The wrapper checks `asciiMock.shouldThrow` and throws when set on the
// ASCII impl; otherwise it delegates to the real `renderMermaidASCII`.
// The SVG impl runs untouched so the render still produces a valid SVG
// in the asciiFailed test (preserves the R025 contract: ASCII fails but
// the render succeeds).
vi.mock("beautiful-mermaid", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		renderMermaidSVG: actual.renderMermaidSVG,
		renderMermaidASCII: (code) => {
			if (asciiMock.shouldThrow) {
				throw new Error("ascii blew up");
			}
			return actual.renderMermaidASCII(code);
		},
	};
});

describe("render()", () => {
	describe("input validation", () => {
		it("rejects the empty string with 'empty mermaid source'", async () => {
			await expect(render("")).rejects.toThrow("empty mermaid source");
		});

		it("rejects whitespace-only strings with 'empty mermaid source'", async () => {
			await expect(render("   ")).rejects.toThrow("empty mermaid source");
			await expect(render("\n\t  \n")).rejects.toThrow("empty mermaid source");
		});

		it("rejects non-string inputs (null, number) with 'empty mermaid source'", async () => {
			await expect(render(null)).rejects.toThrow("empty mermaid source");
			await expect(render(undefined)).rejects.toThrow("empty mermaid source");
			await expect(render(123)).rejects.toThrow("empty mermaid source");
			await expect(render({})).rejects.toThrow("empty mermaid source");
		});

		it("rejects oversized input (> 200_000 chars) with a message naming the length + max", async () => {
			const code = oversizedCode(200_001);
			await expect(render(code)).rejects.toThrow(
				/^mermaid source too long \(200001 chars, max 200000\)/,
			);
		});
	});

	describe("happy path", () => {
		it("returns { id, svg, ascii, sourceLength, asciiFailed } for VALID_GRAPH", async () => {
			const out = await render(VALID_GRAPH);
			// id format: m + base36 timestamp + base36 counter, padStart 3
			expect(out.id).toMatch(/^m[a-z0-9]+$/);
			expect(typeof out.svg).toBe("string");
			expect(out.svg.length).toBeGreaterThan(0);
			expect(out.svg).toContain("<svg");
			expect(typeof out.ascii).toBe("string");
			expect(out.sourceLength).toBe(VALID_GRAPH.length);
			// S03: asciiFailed is always present (true|false) so tools.mjs
			// can increment the ascii_failures counter without re-detecting
			// the sentinel substring.
			expect(out.asciiFailed).toBe(false);
		});
	});

	describe("parse error path", () => {
		it("rejects MALFORMED with a 'mermaid parse error:' prefix", async () => {
			await expect(render(MALFORMED)).rejects.toThrow(/^mermaid parse error:/);
		});
	});

	// -------------------------------------------------------------------
	// M004: only the R025 asciiFailed flag test survives from the S03
	// seam tests. The R015 (timeout) and R018 (jsdom retry) tests are
	// deleted — the synchronous beautiful-mermaid path has neither.
	// -------------------------------------------------------------------

	describe("asciiFailed flag (R025 ascii counter hook)", () => {
		beforeEach(() => {
			asciiMock.shouldThrow = false;
		});
		afterEach(() => {
			asciiMock.shouldThrow = false;
		});

		it("returns asciiFailed: true and the R025 sentinel when renderMermaidASCII throws", async () => {
			asciiMock.shouldThrow = true;
			const out = await render(VALID_GRAPH);
			// The render still succeeds (ASCII is best-effort, R025).
			expect(out.svg).toContain("<svg");
			expect(out.sourceLength).toBe(VALID_GRAPH.length);
			// The boolean lets tools.mjs (T05) increment ascii_failures
			// without re-detecting the sentinel substring.
			expect(out.asciiFailed).toBe(true);
			// The sentinel prefix must match what tools.mjs's
			// ASCII_FAILED_PREFIX detector expects (and the gsd-pi
			// client's startsWith check, see MEM024).
			expect(out.ascii).toMatch(/^\[mermaid-ascii failed: /);
		});
	});

	// -------------------------------------------------------------------
	// __setRenderImplForTesting seam — replaces svg or ascii impl. Used
	// only by future tests; nothing here today exercises it directly
	// (the asciiFailed test above uses vi.mock on the module instead).
	// Kept for parity with the public seam surface in src/render.mjs.
	// -------------------------------------------------------------------

	describe("__setRenderImplForTesting seam", () => {
		afterEach(() => {
			__setRenderImplForTesting(null);
		});

		it("returns to defaults when called with null", () => {
			// First, override both impls with a noop that throws to prove
			// the seam is wired up. Then null-restoring should not throw.
			__setRenderImplForTesting({
				svg: () => "<svg>override</svg>",
				ascii: () => "override-ascii",
			});
			// We don't assert behaviour here (would conflict with the
			// vi.mock above) — the contract is that null cleanly resets.
			expect(() => __setRenderImplForTesting(null)).not.toThrow();
		});
	});
});
