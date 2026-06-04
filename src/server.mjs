// gsd-mermaid-renderer — dual-protocol server (stdio MCP + optional HTTP).
//
// Default: stdio MCP server. Spawned by gsd-pi as a child process. Exposes the
// `render_mermaid` tool to the LLM. No HTTP listening in this mode (port
// conflicts avoided when multiple gsd-pi sessions are open).
//
// Optional HTTP mode (MERMAID_RENDERER_HTTP=1): in addition to MCP, listens
// on 127.0.0.1:5300 for the browser view page + pin API. Started standalone
// via bin/start.sh when the user wants browser access.
//
// Endpoints (HTTP mode only, all on 127.0.0.1:5300):
//   GET  /view?id=<id>            static HTML viewer (file:// works too)
//   POST /pin?id=<id>&pin=true    flip pin flag
//   GET  /raw/svg?id=<id>         raw SVG body
//   GET  /health                  { status, version, total, pinned, unpinned }
//
// Storage is shared across modes:
//   <data>/store.json                # { id -> { code, createdAt, pinned, lastAccessedAt, sourceLength } }
//   <data>/blobs/<id>.svg            # rendered SVG
//   <data>/blobs/<id>.html           # self-contained viewer (works on file://)
//
// Sweep policy: 7 days since createdAt AND !pinned => delete. Run on load,
// on every put, and every hour.

import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { render } from "./render.mjs";
import { LocalFsStorage as Storage, TTL_DAYS } from "./storage/LocalFsStorage.mjs";
import { renderView, extractSvgBody, escapeHtml, fileUrlFor, httpError, log } from "./helpers.mjs";
import { registerTools } from "./tools.mjs";

export { renderView } from "./helpers.mjs";
export { extractSvgBody } from "./helpers.mjs";
export { escapeHtml } from "./helpers.mjs";
export { fileUrlFor } from "./helpers.mjs";
export { httpError } from "./helpers.mjs";
export { log } from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA = process.env.MERMAID_RENDERER_DATA || join(ROOT, "data");
const PUBLIC_DIR = join(ROOT, "public");
const VERSION = "0.1.0";
const startedAt = Date.now();

const HTTP_ENABLED = process.env.MERMAID_RENDERER_HTTP === "1";
const HTTP_PORT = Number.parseInt(process.env.MERMAID_RENDERER_PORT || "5300", 10);
const HTTP_HOST = process.env.MERMAID_RENDERER_HOST || "127.0.0.1";

// StorageBackend factory — the env switch exists (MEM002) so M002's OssStorage
// can plug in without re-plumbing server.mjs. Today only "local" (default) and
// "oss" (stub) are recognised; "oss" logs a stderr line and falls through to
// LocalFsStorage — the actual OSS impl lands in M002.
const BACKEND = process.env.MERMAID_RENDERER_BACKEND;
let storage;
if (BACKEND === "oss") {
	log("MERMAID_RENDERER_BACKEND=oss: 'oss' backend is a stub for M002; falling back to LocalFsStorage");
	storage = new Storage(DATA);
} else {
	// "local" or unset — default
	storage = new Storage(DATA);
}
await storage.load();

setInterval(() => {
	storage.sweep().catch((e) => log("sweep error:", e));
}, 60 * 60 * 1000);

// ============================================================================
// MCP stdio server
// ============================================================================

const mcp = new McpServer(
	{ name: "mermaid-tui-mcp", version: VERSION },
	{ capabilities: { tools: {} } },
);

// Wire the 7 stdio MCP tools (render_mermaid + pin_mermaid + unpin_mermaid +
// list_diagrams + get_diagram + delete_mermaid + search_diagrams) through the
// single seam in src/tools.mjs. The wrapper enforces the R020 envelope and
// adds elapsed_ms; per-tool handlers + their zod schemas live alongside it.
registerTools(mcp, {
	storage,
	render,
	renderView,
	dataDir: DATA,
	httpEnabled: HTTP_ENABLED,
	httpHost: HTTP_HOST,
	httpPort: HTTP_PORT,
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
log(`mcp stdio connected`);

// ============================================================================
// Optional HTTP server (standalone view + pin)
// ============================================================================

if (HTTP_ENABLED) {
	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url, `http://${HTTP_HOST}:${HTTP_PORT}`);
		const cors = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};
		if (req.method === "OPTIONS") {
			res.writeHead(204, cors);
			return res.end();
		}
		const setCors = () => Object.entries(cors).forEach(([k, v]) => res.setHeader(k, v));
		try {
			if (req.method === "GET" && url.pathname === "/view") {
				const id = url.searchParams.get("id");
				if (!id) throw httpError(400, "missing id");
				const entry = await storage.pruneIfExpired(id);
				if (!entry) throw httpError(404, "not found or expired");
				const svg = await storage.readSvg(id);
				if (!svg) throw httpError(404, "svg blob missing");
				const html = await renderView(id, entry, svg, /*withPinButton=*/true);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				return res.end(html);
			}
			if (req.method === "POST" && url.pathname === "/pin") {
				setCors();
				const id = url.searchParams.get("id");
				const pin = url.searchParams.get("pin");
				if (!id) throw httpError(400, "missing id");
				if (pin !== "true" && pin !== "false") throw httpError(400, "pin must be 'true' or 'false'");
				const ok = await storage.setPinned(id, pin === "true");
				if (!ok) throw httpError(404, "not found");
				return json(res, 200, { id, pinned: pin === "true" });
			}
			if (req.method === "GET" && url.pathname === "/raw/svg") {
				setCors();
				const id = url.searchParams.get("id");
				if (!id) throw httpError(400, "missing id");
				const entry = await storage.pruneIfExpired(id);
				if (!entry) throw httpError(404, "not found or expired");
				const svg = await storage.readSvg(id);
				if (!svg) throw httpError(404, "svg blob missing");
				res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8" });
				return res.end(svg);
			}
			if (req.method === "GET" && url.pathname === "/health") {
				setCors();
				return json(res, 200, {
					status: "ok",
					version: VERSION,
					uptimeSec: Math.round((Date.now() - startedAt) / 1000),
					ttlDays: TTL_DAYS,
					...storage.stats(),
				});
			}
			setCors();
			return json(res, 404, { error: "not found" });
		} catch (e) {
			const status = e?.status || 500;
			log(`HTTP ${req.method} ${url.pathname} -> ${status}:`, e?.message || e);
			setCors();
			return json(res, status, { error: e?.message || String(e) });
		}
	});
	httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
		log(`http listening on http://${HTTP_HOST}:${HTTP_PORT}`);
	});
}

// ============================================================================
// Helpers
// ============================================================================
//
// Pure helpers (renderView, extractSvgBody, escapeHtml, fileUrlFor, httpError,
// log) live in src/helpers.mjs and are imported above so they can be unit-tested
// in isolation. The only helper that stays here is `json`, which is a thin
// res.writeHead wrapper used only by the HTTP handler.

function json(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

log(`v${VERSION} ready | data: ${DATA} | http: ${HTTP_ENABLED ? `${HTTP_HOST}:${HTTP_PORT}` : "off"} | stats:`, storage.stats());

// Graceful shutdown — let in-flight renders finish, then exit.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		log(`${sig} received, draining...`);
		setTimeout(() => process.exit(0), 3000).unref();
	});
}
