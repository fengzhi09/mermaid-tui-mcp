// tests/unit/render.test.mjs — unit tests for src/render.mjs.
//
// Covers the input-validation surface (empty / whitespace / non-string /
// oversize), the happy path (returns { id, svg, ascii, sourceLength,
// asciiFailed }), the parse-error path, and the 4 S03 seams (render
// timeout R015, jsdom init 1x retry R018, jsdom init retry exhausted,
// asciiFailed flag). Uses VALID_GRAPH + MALFORMED from
// tests/helpers/render-fixture.mjs so the contract is shared with the
// eval tests (T04).

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MALFORMED, VALID_GRAPH, oversizedCode } from "../helpers/render-fixture.mjs";
import { JsdomInitError, RenderTimeoutError } from "../../src/errors.mjs";
import {
	__resetMermaidForTesting,
	__setJSDOMFactoryForTesting,
	__setMermaidRenderForTesting,
	__setRenderTimeoutForTesting,
	render,
} from "../../src/render.mjs";

// vi.hoisted: state shared with the vi.mock factory below. The factory is
// called during the import phase (before this file's top-level `let`s run),
// so the flag must live in a hoisted scope to avoid a TDZ ReferenceError.
const asciiMock = vi.hoisted(() => ({ shouldThrow: false }));

// Replace mermaid-ascii with a thin wrapper around the real module. The
// wrapper checks `asciiMock.shouldThrow` and throws when set; otherwise it
// delegates to the real `mermaidToAscii`. Other tests (happy path, parse
// error, validation) are unaffected because the flag defaults to false.
vi.mock("mermaid-ascii", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		mermaidToAscii: (code) => {
			if (asciiMock.shouldThrow) {
				throw new Error("ascii blew up");
			}
			return actual.mermaidToAscii(code);
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
	// S03 seams — render timeout (R015), jsdom init 1x retry (R018),
	// jsdom init retry exhausted, asciiFailed flag.
	//
	// Each seam test installs a stub via the __setXForTesting helpers,
	// runs the assertion, then restores the default state in afterEach.
	// -------------------------------------------------------------------

	describe("render timeout (R015)", () => {
		afterEach(() => {
			__setMermaidRenderForTesting(null);
			__setRenderTimeoutForTesting(null);
			__resetMermaidForTesting();
		});

		it("throws RenderTimeoutError (-32001) when mermaid.render never resolves within MERMAID_RENDER_TIMEOUT_MS", async () => {
			// Force the timeout path without flaky timing: a never-resolving
			// promise means the Promise.race will always resolve via the
			// setTimeout callback. A 10ms timeout keeps the test under 1s.
			__setMermaidRenderForTesting(() => new Promise(() => {}));
			__setRenderTimeoutForTesting(10);

			let caught;
			try {
				await render(VALID_GRAPH);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(RenderTimeoutError);
			expect(caught.code).toBe(-32001);
			// Per T02's retryable convention, timeouts are transient
			// (the next request may succeed) — the plan said "retryable
			// false" but the locked enum has retryable: true. We trust
			// the error class.
			expect(caught.retryable).toBe(true);
			expect(caught.name).toBe("RenderTimeoutError");
			// Message must include the timeout value (10ms) so operators
			// can see which budget fired.
			expect(caught.message).toContain("10");
			expect(caught.message).toMatch(/mermaid render exceeded/);
		});
	});

	describe("jsdom init retry (R018)", () => {
		afterEach(() => {
			__setJSDOMFactoryForTesting(null);
			__resetMermaidForTesting();
		});

		it("retries getMermaid() once on first-call failure and succeeds", async () => {
			// First call throws; second call returns a real JSDOM. The
			// retry path should exercise the 1x retry (R018) and let the
			// render complete normally.
			let calls = 0;
			__setJSDOMFactoryForTesting((html, opts) => {
				calls++;
				if (calls === 1) throw new Error("synthetic first-call failure");
				return new JSDOM(html, opts);
			});
			__resetMermaidForTesting();

			const out = await render(VALID_GRAPH);
			expect(out.svg).toContain("<svg");
			expect(out.sourceLength).toBe(VALID_GRAPH.length);
			// Exactly two factory invocations: 1 original + 1 retry.
			// Not more — the retry is bounded to one extra attempt.
			expect(calls).toBe(2);
		});

		it("throws JsdomInitError (-32003) when the retry also fails", async () => {
			// Factory always throws. The retry path should run once
			// (so calls === 2), then surface JsdomInitError.
			let calls = 0;
			__setJSDOMFactoryForTesting(() => {
				calls++;
				throw new Error("synthetic permanent failure");
			});
			__resetMermaidForTesting();

			let caught;
			try {
				await render(VALID_GRAPH);
			} catch (e) {
				caught = e;
			}
			expect(caught).toBeInstanceOf(JsdomInitError);
			expect(caught.code).toBe(-32003);
			expect(caught.retryable).toBe(true); // per T02's convention
			expect(caught.name).toBe("JsdomInitError");
			// The error message must surface the underlying reason (the
			// second attempt's message) so operators can diagnose.
			expect(caught.message).toContain("synthetic permanent failure");
			// Exactly two factory invocations: 1 original + 1 retry.
			// Not three — the retry is bounded to one extra attempt.
			expect(calls).toBe(2);
		});
	});

	describe("asciiFailed flag (S03 ascii counter hook)", () => {
		beforeEach(() => {
			asciiMock.shouldThrow = false;
		});
		afterEach(() => {
			asciiMock.shouldThrow = false;
		});

		it("returns asciiFailed: true and the R025 sentinel when mermaidToAscii throws", async () => {
			asciiMock.shouldThrow = true;
			const out = await render(VALID_GRAPH);
			// The render still succeeds (ASCII is best-effort, R025).
			expect(out.svg).toContain("<svg");
			expect(out.sourceLength).toBe(VALID_GRAPH.length);
			// The boolean lets tools.mjs (T05) increment ascii_failures
			// without re-detecting the sentinel substring.
			expect(out.asciiFailed).toBe(true);
			// The sentinel prefix must match what tools.mjs's
			// ASCII_FAILED_PREFIX detector expects.
			expect(out.ascii).toMatch(/^\[mermaid-ascii failed: /);
		});
	});
});
