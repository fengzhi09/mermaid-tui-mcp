// src/helpers.mjs — pure helpers used by src/server.mjs.
//
// Extracted from server.mjs so they can be unit-tested without importing
// the whole MCP stdio transport bootstrap (which would create a `data/`
// dir, register an hourly sweep interval, and leave the stdio transport
// reading from process.stdin — none of which belong in a unit test).
//
// server.mjs imports these for its own use and re-exports them so the
// public surface (and T01's `grep -c "^export" src/server.mjs` done-when
// count of 6) stay identical.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(resolve(__dirname, ".."), "public");

export async function renderView(id, entry, svg, withPinButton = false) {
	const tmpl = await readFile(join(PUBLIC_DIR, "view.html"), "utf-8");
	return tmpl
		.replace(/\{\{ID\}\}/g, escapeHtml(id))
		.replace(/\{\{ID_JSON\}\}/g, JSON.stringify(id))
		.replace(/\{\{CREATED_AT\}\}/g, new Date(entry.createdAt).toISOString())
		.replace(/\{\{PINNED\}\}/g, entry.pinned ? "true" : "false")
		.replace(/\{\{SOURCE_LENGTH\}\}/g, String(entry.sourceLength ?? entry.code.length))
		.replace(/\{\{SVG_BODY\}\}/g, extractSvgBody(svg))
		.replace(/\{\{CODE\}\}/g, escapeHtml(entry.code))
		.replace(/\{\{WITH_PIN\}\}/g, withPinButton ? "true" : "false")
		.replace(/\{\{TITLE\}\}/g, entry.title ? escapeHtml(entry.title) : "")
		.replace(/\{\{TITLE_JSON\}\}/g, JSON.stringify(entry.title ?? ""));
}

export function extractSvgBody(svg) {
	const m = svg.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
	return m ? m[1] : "";
}

export function escapeHtml(s) {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function fileUrlFor(p) {
	// Cross-platform file URL. on windows: C:\foo\bar.svg -> file:///C:/foo/bar.svg
	const abs = p.replace(/\\/g, "/");
	return `file:///${abs.startsWith("/") ? abs.slice(1) : abs}`;
}

export function httpError(status, msg) {
	const e = new Error(msg);
	e.status = status;
	return e;
}

// All logging MUST go to stderr in stdio MCP mode (stdout is reserved for the
// JSON-RPC protocol). In HTTP mode stderr is fine too — log file if needed.
export function log(...args) {
	const ts = new Date().toISOString().slice(11, 19);
	console.error(`[${ts}][mermaid-renderer]`, ...args);
}
