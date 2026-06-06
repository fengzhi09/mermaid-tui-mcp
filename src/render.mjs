// src/render.mjs — mermaid rendering via beautiful-mermaid.
//
// Synchronous, zero DOM dependencies. beautiful-mermaid's renderMermaidSVG and
// renderMermaidASCII are both sync — no jsdom, no async, no timeout. Each
// `render(code)` call produces both the SVG (real diagram, stored on disk for
// the view page) and an ASCII art fallback that gsd-pi shows in the command
// box.
//
// ASCII is best-effort (R025): an ASCII failure surfaces as the sentinel
// `[mermaid-ascii failed: <msg>]\n<code>` plus `asciiFailed: true` without
// failing the whole render. The sentinel prefix is preserved verbatim from
// the pre-M004 mermaid-ascii@1.0.0 era so external consumers (notably
// extensions/gsd-pi-mermaid-client's `startsWith("[mermaid-ascii failed:")`
// detector) keep working without changes.

import { renderMermaidSVG, renderMermaidASCII } from "beautiful-mermaid";

// --- Test seams (no-ops when not called; live alongside render()) ---
//
// Default = real beautiful-mermaid renderers. Tests can replace either via
// `__setRenderImplForTesting({ svg?, ascii? })`. Pass `null` to restore
// defaults. The seam is partial — only the fields you supply are replaced,
// so the asciiFailed test can override only the ASCII impl while letting
// the real SVG impl run.
let svgImplOverride = null;
let asciiImplOverride = null;

/**
 * Replace the internal SVG/ASCII renderers for testing. Each field is
 * optional; pass `null` to clear all overrides.
 *
 * @param {{ svg?: (code: string) => string, ascii?: (code: string) => string } | null} opts
 */
export function __setRenderImplForTesting(opts) {
	svgImplOverride = opts && typeof opts.svg === "function" ? opts.svg : null;
	asciiImplOverride = opts && typeof opts.ascii === "function" ? opts.ascii : null;
}

let idCounter = 0;
function nextId() {
	// monotonic, base36, short, sortable
	return `m${Date.now().toString(36)}${(++idCounter).toString(36).padStart(3, "0")}`;
}

/**
 * Render a mermaid source string.
 *
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

	// SVG step. Errors here are fatal (the caller needs the SVG to embed
	// in the HTML viewer). The message is wrapped in the "mermaid parse
	// error:" prefix so src/errors.mjs:classifyDomainError maps it to
	// -32002 RenderFailed (retryable: false) per the inner-payload
	// contract — the 9 existing eval tests' substring assertions on
	// /^mermaid parse error:/ keep working.
	let svg;
	try {
		svg = svgImplOverride ? svgImplOverride(code) : renderMermaidSVG(code);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`mermaid parse error: ${msg.slice(0, 500)}`);
	}

	// ASCII step. Best-effort per R025: a failure here MUST NOT abort
	// the render. The sentinel preserves the historical format
	// (`[mermaid-ascii failed: <msg>]\n<code>`, closing `]`, NOT `)`)
	// so the existing ASCII_FAILED_PREFIX detector in src/tools.mjs and
	// the startsWith assertion in extensions/gsd-pi-mermaid-client's
	// tests both keep working unchanged.
	let ascii;
	let asciiFailed = false;
	try {
		ascii = asciiImplOverride ? asciiImplOverride(code) : renderMermaidASCII(code);
	} catch (e) {
		asciiFailed = true;
		const msg = e instanceof Error ? e.message : String(e);
		ascii = `[mermaid-ascii failed: ${msg}]\n${code}`;
	}

	return { id: nextId(), svg, ascii, sourceLength: code.length, asciiFailed };
}
