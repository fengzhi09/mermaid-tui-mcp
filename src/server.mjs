#!/usr/bin/env node
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
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { render } from "./render.mjs";
import { TTL_DAYS } from "./storage/LocalFsStorage.mjs";
import { buildStorageFromEnv, renderView, extractSvgBody, escapeHtml, fileUrlFor, httpError, log } from "./helpers.mjs";
import { registerTools } from "./tools.mjs";
import { Counters } from "./counters.mjs";
import { tryListen } from "./port-fallback.mjs";
import { recordError, setLastRenderMs, snapshot as healthSnapshot, setBootDegraded, setBootOssFailure } from "./health-state.mjs";
import { LocalFsStorage } from "./storage/LocalFsStorage.mjs";

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
const VERSION = "0.3.0";
const startedAt = Date.now();

// D017: HTTP 是附加能力,不是核心.端口全部被占时降级到 stdio-only,继续服务 MCP.
// 写成 let 而非 const 是为了在 tryListen 失败回调里能 flip.
let httpEnabled = process.env.MERMAID_RENDERER_HTTP === "1";
const HTTP_PORT = Number.parseInt(process.env.MERMAID_RENDERER_PORT || "5300", 10);
const HTTP_HOST = process.env.MERMAID_RENDERER_HOST || "127.0.0.1";

// StorageBackend factory — the env switch exists (MEM002) so M002's OssStorage
// can plug in without re-plumbing server.mjs. "local" (default) uses the
// on-disk LocalFsStorage; "oss" builds a S3-compatible OssStorage from the
// MERMAID_OSS_* env vars (T03). On missing/empty required vars the factory
// throws OssEnvInvalidError; M003/S03/T01 routes that to the degraded-boot
// path (emit `oss_init_degraded` warn-level log, fall back to LocalFsStorage,
// continue serving MCP) — OSS is an optional integration per D017. The
// factory itself has already emitted `oss_env_invalid` (level=error) so the
// operator's log shipper sees the configuration issue even if the boot log
// is missed.
// S02 (T01) collapsed the 15-line if/else into a single buildStorageFromEnv
// call. The helper in src/helpers.mjs is the same factory the migration CLI
// (bin/migrate-to-oss.mjs) uses — one source of truth for "given an env,
// return the right StorageBackend".

// S03 (R010): persistent monotonic counters — the 6-key set the /health
// surface reads, persisted to <root>/counters.json via tmp+rename. Loaded
// synchronously here so the first tool call after boot sees the persisted
// state. The Counters instance is passed to buildStorageFromEnv so the
// constructed storage can increment on sweep / write-retry paths, and to
// registerTools via ctx so the wrapper can bump render_total /
// render_errors / ascii_failures.
const counters = new Counters(DATA);
await counters.load();

// D017: 可选集成失败不阻塞主流程.OSS env 缺失/无效时降级到 local,记 warn 日志,
// 继续 boot 走 stdio MCP.R-D018 follow-up: 把 storage.health() 暴露给 /health,
// 让运维可通过 degraded 字段发现"OSS 配错"而不是误以为 OSS 在工作.
//
// M003/S03/T01: 把 boot 路径的 catch 分流 — OssEnvInvalidError 是 optional
// 集成的配置错(降级 + 计数 + 强 warn),其他初始化错误是真正致命的(仍
// exit(1),让运维看见). 工厂已在内部发过 `oss_env_invalid` (level=error)
// 反映"OSS 配置有问题",boot 这里只发 `oss_init_degraded` (level=warn)
// 反映"我已优雅降级, server 仍可工作".
let storage;
try {
	storage = buildStorageFromEnv(process.env, { dataDir: DATA, counters, logger: log });
} catch (err) {
	if (err && err.name === "OssEnvInvalidError") {
		// Optional 集成 (OSS) 配置错. 降级到 local, 不退出.
		const errorText = String(err?.message || err);
		const missing = Array.isArray(err.missing) ? err.missing : [];
		// JSON-RPC-family code -32006 mirrors OssEnvInvalidError.code so
		// downstream log shippers can correlate factory + boot events.
		log({
			level: "warn",
			event: "oss_init_degraded",
			code: -32006,
			missing,
			fallback: "local",
			hint: "OSS env vars missing/invalid; booting with local storage. Fix MERMAID_OSS_* to enable cloud.",
		});
		// Bump the M003 counter so /health surfaces this degraded boot.
		if (counters) {
			await counters.increment("oss_init_degraded_count");
		}
		// T04 /health extension: record the boot as degraded (so the
		// /health handler can return `backend: "degraded"` even though
		// the runtime storage is now a pure LocalFsStorage with no
		// .health() method to introspect), and record the OSS failure
		// shape so the top-level `last_oss_failure` field carries the
		// same info the /health consumer expects. Both calls are
		// module-level in-memory writes (no I/O), safe in the
		// boot-time async flow.
		setBootDegraded(true);
		setBootOssFailure({ ts: Date.now(), code: -32006, msg: errorText });
		storage = new LocalFsStorage(DATA, { counters, logger: log });
	} else {
		// 非 OssEnvInvalidError = 真正致命的初始化错 (如: 本地 fs 不可写,
		// 工厂内部崩溃). 退出让运维看到, 不要悄悄降级掩盖问题.
		const errorText = String(err?.message || err);
		log({
			level: "error",
			event: "oss_init_failed",
			error: errorText,
			hint: "Non-OssEnvInvalidError during storage init; aborting boot so the operator sees the failure.",
		});
		process.exit(1);
	}
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
	httpEnabled: httpEnabled,
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

if (httpEnabled) {
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
			// M003 S02 T02: static-file route for /themes/* (serves
			// public/themes/main.css and the 4 individual theme files).
			// Without this, view.html's <link rel="stylesheet" href="/themes/main.css">
			// returns 404 and the page renders unstyled. Path is
			// restricted to public/themes/ to prevent traversal
			// (e.g. /themes/../../etc/passwd). The theme files are
			// static — no MIME sniffing, no auth — matching the
			// S02-PLAN "static css" decision.
			if (req.method === "GET" && url.pathname.startsWith("/themes/")) {
				const themesRoot = resolve(join(PUBLIC_DIR, "themes"));
				const rel = url.pathname.slice("/themes/".length);
				if (rel.split("/").some((s) => s === "" || s === "." || s === "..")) {
					throw httpError(400, "invalid path");
				}
				const filePath = resolve(join(themesRoot, rel));
				if (filePath !== themesRoot && !filePath.startsWith(themesRoot + sep)) {
					throw httpError(403, "forbidden");
				}
				let content;
				try {
					content = await readFile(filePath);
				} catch (e) {
					if (e?.code === "ENOENT") throw httpError(404, "not found");
					throw e;
				}
				const ext = extname(filePath).toLowerCase();
				const mime =
					ext === ".css" ? "text/css; charset=utf-8"
					: ext === ".js" ? "application/javascript; charset=utf-8"
					: ext === ".svg" ? "image/svg+xml; charset=utf-8"
					: ext === ".png" ? "image/png"
					: "application/octet-stream";
				setCors();
				res.writeHead(200, { "Content-Type": mime });
				return res.end(content);
			}
			if (req.method === "GET" && url.pathname === "/health") {
				setCors();
				// S03 (R009) extension: merge counters.snapshot() and the
				// health-state snapshot into the existing /health shape.
				// D018 extension: storage.health() (only present when storage
				// is a DegradableStorage — i.e. OSS backend was selected) is
				// spread in to expose degraded / consecutive_failures /
				// degraded_reason / fallback_root to operators. Backward
				// compat: when storage has no .health() (pure LocalFsStorage),
				// we omit the block — the /health shape stays byte-identical
				// to M002.
				// The full response is now:
				//   {status, version, uptimeSec, ttlDays, total, pinned, unpinned,
				//    counters, last_render_ms, last_errors,
				//    backend, last_oss_failure,
				//    storage: { degraded, degraded_reason, consecutive_failures, ... }}
				const storageHealth = typeof storage.health === "function" ? storage.health() : null;
				// T04 /health extension — compute the top-level `backend`
				// and `last_oss_failure` fields. Both follow D017 (OSS is
				// optional, status surfaces degraded) and rely on the
				// health-state for boot-degraded tracking because the
				// boot path falls back to a pure LocalFsStorage (no
				// .health() to introspect).
				//
				// backend resolution priority:
				//   1. boot-degraded (OssEnvInvalidError at boot)  → "degraded"
				//      (this is the most important signal — the operator
				//      expected OSS, got a quiet local fallback)
				//   2. DegradableStorage with breaker open          → "degraded"
				//   3. DegradableStorage with breaker closed        → "oss"
				//   4. plain OssStorage                             → "oss"
				//   5. plain LocalFsStorage (no OSS configured)     → "local"
				//
				// last_oss_failure resolution priority (the /health
				// consumer wants the FIRST observed OSS failure, which
				// during a degraded boot is the env-missing one):
				//   1. boot-time record (set by setBootOssFailure)   → that
				//   2. DegradableStorage.breaker.lastFailure         → mapped {ts: at, code, msg: message}
				//   3. plain OssStorage.breaker.lastFailure          → mapped same way
				//   4. no failure observed yet                       → null
				const hs = healthSnapshot();
				let backend;
				if (hs.boot_degraded) {
					backend = "degraded";
				} else if (storageHealth) {
					backend = storageHealth.degraded ? "degraded" : "oss";
				} else {
					// No DegradableStorage wrapper — we still need to
					// distinguish pure OssStorage ("oss") from pure
					// LocalFsStorage ("local"). The bucket name is the
					// only signal we have; the LocalFsStorage.root is a
					// filesystem path, OssStorage.root is the bucket
					// string. We duck-type: a root containing "/" or a
					// drive letter is a filesystem path; otherwise it's
					// a bucket name.
					const root = storage.root || "";
					backend = root && !/[\\/]/.test(root) ? "oss" : "local";
				}
				let lastOssFailure = hs.last_oss_failure;
				if (!lastOssFailure && storageHealth && storageHealth.last_failure) {
					const lf = storageHealth.last_failure;
					lastOssFailure = { ts: lf.at, code: lf.code ?? null, msg: lf.message };
				} else if (!lastOssFailure && typeof storage.breaker === "object" && storage.breaker && storage.breaker.lastFailure) {
					const lf = storage.breaker.lastFailure;
					lastOssFailure = { ts: lf.at, code: lf.code ?? null, msg: lf.message };
				}
				return json(res, 200, {
					status: "ok",
					version: VERSION,
					uptimeSec: Math.round((Date.now() - startedAt) / 1000),
					ttlDays: TTL_DAYS,
					...storage.stats(),
					counters: counters.snapshot(),
					...healthSnapshot(),
					backend,
					last_oss_failure: lastOssFailure,
					...(storageHealth ? { storage: storageHealth } : {}),
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
			// D017: 端口全被占不算致命错误,降级到 stdio-only 继续服务.
			// /health / /view / /pin 这类 HTTP-only 端点不可用,但 stdio MCP
			// 工具 (render_mermaid 等) 不受影响.
			log({
				level: "warn",
				event: "http_listen_failed_fallback",
				error: String(e?.message || e),
				ports_tried: [HTTP_PORT, HTTP_PORT + 1, HTTP_PORT + 2],
				fallback: "stdio-only",
				hint: "All HTTP ports busy; server running in stdio MCP mode only.",
			});
			httpEnabled = false;
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

// storage.root is the StorageBackend's opaque data-location token: for
// LocalFsStorage it's the data directory (= DATA), for OssStorage it's the
// bucket name. Using storage.root keeps the boot record backend-agnostic
// while making it obvious at a glance which backend is active (a /bucket
// name vs a local /data path).
log({ event: "boot", version: VERSION, data: storage.root, http: httpEnabled, stats: storage.stats() });

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
