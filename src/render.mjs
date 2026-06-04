// mermaid rendering + ASCII art conversion.
//
// Initialises the browser-shaped DOM globals mermaid needs (jsdom + getBBox
// polyfill) once on first use, then caches the parser. Each `render(code)` call
// produces both the SVG (real diagram, stored on disk for the view page) and an
// ASCII art fallback that gsd-pi shows in the command box.

import { JSDOM } from "jsdom";
import { mermaidToAscii } from "mermaid-ascii";

import { RenderTimeoutError, JsdomInitError } from "./errors.mjs";

// Read the render timeout env var once at module load. Default 10s per R015.
// Cached in a const so the hot path doesn't re-read process.env on every call.
// The test seam `__setRenderTimeoutForTesting(ms)` can override this at test
// time so the timeout test fires in < 1s instead of waiting the full 10s.
const RENDER_TIMEOUT_MS = (() => {
	const v = Number(process.env.MERMAID_RENDER_TIMEOUT_MS);
	return Number.isFinite(v) && v > 0 ? v : 10_000;
})();

// Mutable for test seams. Default = real JSDOM constructor. The timeout test
// (see `__setMermaidRenderForTesting` below) does NOT touch this — it only
// replaces the mermaid.render call. The jsdom retry test replaces this so it
// can force a first-call failure and exercise the 1x retry path (R018).
let jsdomFactory = (html, opts) => new JSDOM(html, opts);
// Mutable for test seam. Default = null → use the real `mermaid.render(id,
// code)`. When set, the supplied function `(id, code) => Promise<{svg}>` is
// called instead. The timeout test uses a never-resolving promise to force
// the Promise.race → timeout path.
let mermaidRenderImpl = null;
// Mutable for test seam. Default = null → use the cached RENDER_TIMEOUT_MS.
// When set to a positive number, that number of ms is used as the timeout.
let _renderTimeoutMsOverride = null;

let mermaidPromise = null;

function getRenderTimeoutMs() {
	return _renderTimeoutMsOverride !== null ? _renderTimeoutMsOverride : RENDER_TIMEOUT_MS;
}

async function initMermaid() {
	const dom = jsdomFactory("<!DOCTYPE html><html><body></body></html>", {
		pretendToBeVisual: true,
		runScripts: "outside-only",
	});
	// jsdom does not implement SVGGraphicsElement.getBBox — mermaid 11 needs it.
	dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
	function setGlobal(key, val) {
		try {
			globalThis[key] = val;
		} catch {
			Object.defineProperty(globalThis, key, { value: val, writable: true, configurable: true });
		}
	}
	for (const k of [
		"window",
		"document",
		"navigator",
		"HTMLElement",
		"SVGElement",
		"Element",
		"Node",
		"NodeList",
		"getComputedStyle",
		"CSSStyleSheet",
		"matchMedia",
	]) {
		const v =
			dom.window[k] ??
			(k === "matchMedia" ? () => ({ matches: false, addListener() {}, removeListener() {} }) : undefined);
		if (v !== undefined) setGlobal(k, v);
	}
	const mermaid = (await import("mermaid")).default;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "loose",
		theme: "default",
		fontFamily: "trebuchet ms, verdana, arial, sans-serif",
	});
	return mermaid;
}

async function getMermaid() {
	if (mermaidPromise) return mermaidPromise;
	// First attempt. The promise is cached so concurrent callers share it —
	// a single rejection means all of them see the same failure.
	mermaidPromise = initMermaid();
	try {
		return await mermaidPromise;
	} catch (firstErr) {
		// First attempt failed; clear and retry exactly once (R018).
		mermaidPromise = null;
		mermaidPromise = initMermaid();
		try {
			return await mermaidPromise;
		} catch (retryErr) {
			mermaidPromise = null;
			// Surface the SECOND attempt's message (the one the caller
			// actually saw) so logs reflect what the retry ran into.
			const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
			throw new JsdomInitError(`jsdom init failed: ${msg}`);
		}
	}
}

let idCounter = 0;
function nextId() {
	// monotonic, base36, short, sortable
	return `m${Date.now().toString(36)}${(++idCounter).toString(36).padStart(3, "0")}`;
}

/**
 * Render a mermaid source string.
 * @param {string} code
 * @returns {Promise<{id: string, svg: string, ascii: string, sourceLength: number, asciiFailed: boolean}>}
 */
export async function render(code) {
	if (typeof code !== "string" || code.trim().length === 0) {
		throw new Error("empty mermaid source");
	}
	if (code.length > 200_000) {
		throw new Error(`mermaid source too long (${code.length} chars, max 200000)`);
	}
	const mermaid = await getMermaid();
	const id = nextId();
	let svg;
	try {
		const timeoutMs = getRenderTimeoutMs();
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new RenderTimeoutError(`mermaid render exceeded ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		const renderPromise = mermaidRenderImpl
			? mermaidRenderImpl(id, code)
			: mermaid.render(id, code);
		try {
			const out = await Promise.race([renderPromise, timeoutPromise]);
			clearTimeout(timer);
			svg = out.svg;
		} catch (e) {
			// Clear the timer in both branches: on success it's a no-op
			// (timer already cleared), on failure it prevents the setTimeout
			// callback from firing after we've already given up.
			clearTimeout(timer);
			throw e;
		}
	} catch (e) {
		// RenderTimeoutError passes through unchanged so callers (and
		// classifyDomainError in src/errors.mjs) can read the -32001 code
		// straight off the .code property. Every other error gets the
		// historical "mermaid parse error:" prefix so the 9 existing
		// eval tests' substring assertions and the -32002 mapping
		// (classifyDomainError) keep working.
		if (e && typeof e === "object" && e.name === "RenderTimeoutError") {
			throw e;
		}
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`mermaid parse error: ${msg.slice(0, 500)}`);
	}
	let ascii;
	let asciiFailed = false;
	try {
		ascii = mermaidToAscii(code);
	} catch (e) {
		// ASCII is best-effort; never fail the whole render because of it
		// (R025). Surface the failure as the sentinel + a boolean so
		// tools.mjs (T05) can increment the ascii_failures counter without
		// re-detecting the sentinel substring.
		asciiFailed = true;
		const msg = e instanceof Error ? e.message : String(e);
		ascii = `[mermaid-ascii failed: ${msg}]\n${code}`;
	}
	return { id, svg, ascii, sourceLength: code.length, asciiFailed };
}

// --- Test seams (no-ops when not called; live alongside render()) ---

/**
 * Replace the internal mermaid.render call. The supplied function takes
 * `(id, code)` and returns a `Promise<{svg: string}>`. Pass `null` to
 * restore the real `mermaid.render(id, code)`. Used by the timeout test
 * (pass a never-resolving promise to force the timeout path) and
 * reserved for future tests.
 */
export function __setMermaidRenderForTesting(fn) {
	mermaidRenderImpl = typeof fn === "function" ? fn : null;
}

/**
 * Replace the internal JSDOM factory. The supplied function takes
 * `(html, opts)` and returns a JSDOM instance. Pass `null` to restore
 * the real `new JSDOM(html, opts)`. Used by the jsdom retry test (throw
 * on first call, return a valid JSDOM on second call to exercise the
 * R018 1x retry path).
 */
export function __setJSDOMFactoryForTesting(fn) {
	jsdomFactory =
		typeof fn === "function" ? fn : (html, opts) => new JSDOM(html, opts);
}

/**
 * Clear the cached mermaid init promise so the next getMermaid() call
 * re-runs initMermaid (using whatever factory is currently installed).
 * Used by the jsdom retry test to start from a clean cache.
 */
export function __resetMermaidForTesting() {
	mermaidPromise = null;
}

/**
 * Override the cached render timeout for tests. The production path
 * reads MERMAID_RENDER_TIMEOUT_MS once at module load; this seam lets
 * the timeout test force a short timeout (< 1s) without waiting the
 * full default 10s. Pass `null` to restore the cached value.
 */
export function __setRenderTimeoutForTesting(ms) {
	_renderTimeoutMsOverride = typeof ms === "number" && ms > 0 ? ms : null;
}
