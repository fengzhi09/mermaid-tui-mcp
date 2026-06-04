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
//   GET  /health                  { status, version, ..., counters, last_render_ms, last_errors }
//
// Storage is shared across modes:
//   <data>/store.json                # { id -> { code, createdAt, pinned, lastAccessedAt, sourceLength } }
//   <data>/blobs/<id>.svg            # rendered SVG
//   <data>/blobs/<id>.html           # self-contained viewer (works on file://)
//   <data>/counters.json             # persistent monotonic counters (R010)
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
import { Counters } from "./counters.mjs";
import { tryListen } from "./port-fallback.mjs";
import { recordError, setLastRenderMs, snapshot as healthSnapshot } from "./health-state.mjs";

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
const VERSION = "0.2.0";
const startedAt = Date.now();

const HTTP_ENABLED = process.env.MERMAID_RENDERER_HTTP === "1";
const HTTP_PORT = Number.parseInt(process.env.MERMAID_RENDERER_PORT || "5300", 10);
const HTTP_HOST = process.env.MERMAID_RENDERER_HOST || "127.0.0.1";

// StorageBackend factory — the env switch exists (MEM002) so M002's OssStorage
// can plug in without re-plumbing server.mjs. Today only "local" (default) and
// "oss" (stub) are recognised; "oss" logs a stderr line and falls through to
// LocalFsStorage — the actual OSS impl lands in M002.
const BACKEND = process.env.MERMAID_RENDERER_BACKEND;

// S03 (R010): persistent monotonic counters — the 6-key set the /health
// surface reads, persisted to <root>/counters.json via tmp+rename. Loaded
// synchronously here so the first tool call after boot sees the persisted
// state. The Counters instance is passed to LocalFsStorage so sweep +
// write-retry paths can increment, and to registerTools via ctx so the
// wrapper can bump render_total / render_errors / ascii_failures.
const counters = new Counters(DATA);
await counters.load();

let storage;
if (BACKEND === "oss") {
	log({ level: "warn", event: "backend_stub", backend: "oss" });
	storage = new Storage(DATA, { counters, logger: log });
} else {
	// "local" or unset — default
	storage = new Storage(DATA, { counters, logger: log });
}
await storage.load();

// Hourly sweep — .unref() keeps the setInterval from holding the event
// loop open after stdio closes (MEM017). The previous band-aid was a
// SIGTERM→SIGKILL escalation in tests/helpers/server.mjs; the proper
// fix is to make the interval not keep the loop alive. The unref'd
// setTimeout in the SIGTERM handler below does the same for shutdown.
setInterval(() => {
	storage.sweep().catch((e) => log({ level: "error", event: "sweep_error", error: String(e?.message || e) }));
}, 60 * 60 * 1000).unref();

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
//
// S03 (R008/R009/R010): the wrapper also emits a structured stderr JSON
// log on every tool call (success + failure), increments the matching
// counter, and pushes tagged failures into the 5-error ring + last_render_ms
// state exposed by /health. All four are optional in the wrapper — if
// absent the wrapper continues without the observability surface.
registerTools(mcp, {
	storage,
	render,
	renderView,
	dataDir: DATA,
	httpEnabled: HTTP_ENABLED,
	httpHost: HTTP_HOST,
	httpPort: HTTP_PORT,
	counters,
	logger: log,
	recordError,
	setLastRenderMs,
});

const transport = new StdioServerTransport();
await mcp.connect(transport);
log({ event: "mcp_stdio_connected" });

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
				// S03 (R009) extension: merge counters.snapshot() and the
				// health-state snapshot into the existing /health shape.
				// The full response is now:
				//   {status, version, uptimeSec, ttlDays, total, pinned, unpinned,
				//    counters, last_render_ms, last_errors}
				// last_errors is always an array (possibly empty) per the
				// S03 research decision. counters is always an object with
				// the 6 documented keys (0-defaulted if unused).
				return json(res, 200, {
					status: "ok",
					version: VERSION,
					uptimeSec: Math.round((Date.now() - startedAt) / 1000),
					ttlDays: TTL_DAYS,
					...storage.stats(),
					counters: counters.snapshot(),
					...healthSnapshot(),
				});
			}
			setCors();
			return json(res, 404, { error: "not found" });
		} catch (e) {
			const status = e?.status || 500;
			log({ level: "error", event: "http_error", method: req.method, path: url.pathname, status, error: String(e?.message || e) });
			setCors();
			return json(res, status, { error: e?.message || String(e) });
		}
	});
	// R016: try 5300 → 5301 → 5302. If all three are in use, the helper
	// throws PortInUseError — we log a structured `http_listen_failed`
	// event and exit(1) so the operator sees the failure in the daemon
	// launcher (or the parent process tree) instead of the silent
	// "this just hung on port 5300" failure mode. The tryListen helper
	// logs a `port_in_use` event for each candidate it skips, so a
	// follow-up log trail shows the full fallback attempt.
	tryListen(httpServer, HTTP_HOST, [HTTP_PORT, HTTP_PORT + 1, HTTP_PORT + 2])
		.then((port) => {
			// Override HTTP_PORT in the listening log so the operator sees
			// the actual bound port, not the originally requested one.
			log({ event: "http_listening", host: HTTP_HOST, port });
		})
		.catch((e) => {
			log({ level: "error", event: "http_listen_failed", error: String(e?.message || e), port: HTTP_PORT });
			process.exit(1);
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

log({ event: "boot", version: VERSION, data: DATA, http: HTTP_ENABLED, stats: storage.stats() });

// Graceful shutdown — let in-flight renders finish, then exit. The
// setTimeout is unref'd so it doesn't hold the loop open if stdio
// has already closed (the SIGTERM handler in the test helper still
// escalates SIGTERM→SIGKILL as defense-in-depth).
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		log({ event: "shutdown", signal: sig });
		setTimeout(() => process.exit(0), 3000).unref();
	});
}
