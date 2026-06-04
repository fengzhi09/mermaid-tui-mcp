// tests/unit/render.test.mjs — unit tests for src/render.mjs.
//
// Covers the input-validation surface (empty / whitespace / non-string /
// oversize), the happy path (returns { id, svg, ascii, sourceLength }),
// and the parse-error path. Uses VALID_GRAPH + MALFORMED from
// tests/helpers/render-fixture.mjs so the contract is shared with the
// eval tests (T04).

import { describe, expect, it } from "vitest";

import { MALFORMED, VALID_GRAPH, oversizedCode } from "../helpers/render-fixture.mjs";
import { render } from "../../src/render.mjs";

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
		it("returns { id, svg, ascii, sourceLength } for VALID_GRAPH", async () => {
			const out = await render(VALID_GRAPH);
			// id format: m + base36 timestamp + base36 counter, padStart 3
			expect(out.id).toMatch(/^m[a-z0-9]+$/);
			expect(typeof out.svg).toBe("string");
			expect(out.svg.length).toBeGreaterThan(0);
			expect(out.svg).toContain("<svg");
			expect(typeof out.ascii).toBe("string");
			expect(out.sourceLength).toBe(VALID_GRAPH.length);
		});
	});

	describe("parse error path", () => {
		it("rejects MALFORMED with a 'mermaid parse error:' prefix", async () => {
			await expect(render(MALFORMED)).rejects.toThrow(/^mermaid parse error:/);
		});
	});
});
