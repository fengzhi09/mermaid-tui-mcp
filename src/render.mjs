// mermaid rendering + ASCII art conversion.
//
// Initialises the browser-shaped DOM globals mermaid needs (jsdom + getBBox
// polyfill) once on first use, then caches the parser. Each `render(code)` call
// produces both the SVG (real diagram, stored on disk for the view page) and an
// ASCII art fallback that gsd-pi shows in the command box.

import { JSDOM } from "jsdom";
import { mermaidToAscii } from "mermaid-ascii";

let mermaidPromise = null;

async function getMermaid() {
	if (mermaidPromise) return mermaidPromise;
	mermaidPromise = (async () => {
		const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
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
				dom.window[k] ?? (k === "matchMedia" ? () => ({ matches: false, addListener() {}, removeListener() {} }) : undefined);
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
	})();
	return mermaidPromise;
}

let idCounter = 0;
function nextId() {
	// monotonic, base36, short, sortable
	return `m${Date.now().toString(36)}${(++idCounter).toString(36).padStart(3, "0")}`;
}

/**
 * Render a mermaid source string.
 * @param {string} code
 * @returns {Promise<{id: string, svg: string, ascii: string, sourceLength: number}>}
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
		const out = await mermaid.render(id, code);
		svg = out.svg;
	} catch (e) {
		// mermaid throws with the offending token highlighted; surface as a
		// distinct error code so the gsd-pi extension can show a useful msg.
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`mermaid parse error: ${msg.slice(0, 500)}`);
	}
	let ascii;
	try {
		ascii = mermaidToAscii(code);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// ASCII is best-effort; never fail the whole render because of it.
		ascii = `[mermaid-ascii failed: ${msg}]\n${code}`;
	}
	return { id, svg, ascii, sourceLength: code.length };
}
