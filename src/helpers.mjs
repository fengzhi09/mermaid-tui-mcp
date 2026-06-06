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

import { log as loggerLog } from "./logger.mjs";
// Aliased to `_LocalFsStorage` to avoid clashing with the
// `import { LocalFsStorage as Storage }` pattern in src/server.mjs.
// The helper is consumed by both server.mjs (boot path) and
// bin/migrate-to-oss.mjs (CLI source/target factory) — the alias
// keeps callers' namespaces independent of helpers' internal naming.
import { LocalFsStorage as _LocalFsStorage } from "./storage/LocalFsStorage.mjs";
import { OssStorageFromEnv as _OssStorageFromEnv } from "./storage/OssStorage.mjs";
import { DegradableStorage as _DegradableStorage } from "./storage/DegradableStorage.mjs";

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

// Re-export the structured stderr JSON logger (R008). The body lives in
// src/logger.mjs so tests can import it directly without going through
// helpers.mjs. Keeping the named export here preserves the 6
// single-name ^export invariant in src/server.mjs (MEM015 + S01 audit).
export const log = loggerLog;

/**
 * Env-driven factory that returns the right StorageBackend for the
 * renderer. Pure function of its inputs (no I/O, no `.load()`) so the
 * migration CLI in bin/migrate-to-oss.mjs and the server's boot path
 * can share a single source of truth for "given an env, return the
 * right StorageBackend" — the "wiring cleanup" promised in the S02
 * title. The two call sites only differ in the env they read and the
 * failure-mode handler; the construction logic is identical.
 *
 * - env is a plain object (typically `process.env`) holding
 *   MERMAID_RENDERER_* and MERMAID_OSS_* vars.
 * - opts is `{ dataDir, counters, logger, readTimeoutMs, createBucket }`:
 *   - dataDir      required for the local backend; defaults to
 *                  process.env.MERMAID_RENDERER_DATA. The OssStorage
 *                  backend ignores dataDir (its root is the bucket name).
 *   - counters     S03 (R010) persistent counters instance — pass-through.
 *   - logger       {log: Function} (R008) structured logger — pass-through.
 *   - readTimeoutMs optional oss read budget override (default 5000ms).
 *   - createBucket optional OssStorage.createBucket flag (default false).
 *
 * Returns either LocalFsStorage or OssStorage based on
 * `env.MERMAID_RENDERER_BACKEND === "oss"`. On missing MERMAID_OSS_*
 * vars the OssStorageFromEnv factory throws OssEnvInvalidError — we
 * let it propagate; the caller decides whether to exit(1) (server.mjs)
 * or emit a human message (the CLI). The factory already emits the
 * `oss_env_invalid` structured log line before throwing, so the
 * rejection is observable in the log stream regardless of how the
 * caller handles the exception.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   dataDir?: string,
 *   counters?: import("./counters.mjs").Counters | null,
 *   logger?: {log?: Function} | null,
 *   readTimeoutMs?: number,
 *   createBucket?: boolean,
 * }} [opts]
 * @returns {import("./storage/LocalFsStorage.mjs").LocalFsStorage | import("./storage/OssStorage.mjs").OssStorage | import("./storage/DegradableStorage.mjs").DegradableStorage}
 *   当 MERMAID_RENDERER_BACKEND=oss 时返回 DegradableStorage (primary=OssStorage, fallback=LocalFsStorage),
 *   /health 通过 storage.health() 读 degraded 状态. local 路径返回纯 LocalFsStorage.
 */
export function buildStorageFromEnv(env, opts = {}) {
	const backend = env.MERMAID_RENDERER_BACKEND;
	if (backend === "oss") {
		// OssStorageFromEnv validates the 5 required MERMAID_OSS_* vars
		// and throws OssEnvInvalidError with the ordered missing-var list
		// when any are absent. Pass opts through verbatim so the migration
		// CLI can wire createBucket / counters / logger the same way the
		// server's boot path does.
		//
		// D017: 包一层 DegradableStorage, 让 OSS 运行时失败 (S3 抖动/网络分区/
		// 凭据过期) 不阻塞主流程 — 连续 N 次失败后切 local 兜底, /health 暴露
		// degraded 状态. 阈值 N 默认 3, 可通过 opts.threshold 注入 (测试).
		const primary = _OssStorageFromEnv(env, opts);
		const fallbackDataDir = (opts && typeof opts.dataDir === "string" && opts.dataDir.length > 0)
			? opts.dataDir
			: (env.MERMAID_RENDERER_DATA || "");
		const fallback = new _LocalFsStorage(fallbackDataDir, {
			counters: opts && opts.counters !== undefined ? opts.counters : null,
			logger: opts && opts.logger !== undefined ? opts.logger : null,
		});
		const thresholdRaw = Number.parseInt(env.MERMAID_DEGRADE_THRESHOLD || "", 10);
		const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : undefined;
		// S03 T03: 半开探测窗 (从 breaker_open 起到第一次允许探测的 ms).
		// 默认 60000ms (OssStorage.breaker 默认). 通过 MERMAID_DEGRADE_HALF_OPEN_AFTER_MS
		// 覆盖. 测试可走 opts.halfOpenAfterMs 直接注入.
		const halfOpenAfterMsRaw = Number.parseInt(env.MERMAID_DEGRADE_HALF_OPEN_AFTER_MS || "", 10);
		const halfOpenAfterMs = Number.isFinite(halfOpenAfterMsRaw) && halfOpenAfterMsRaw > 0 ? halfOpenAfterMsRaw : undefined;
		return new _DegradableStorage(primary, fallback, {
			threshold,
			halfOpenAfterMs,
			logger: opts && opts.logger !== undefined ? opts.logger : null,
			// S03 T03: pass counters through so _emitBreakerOpen's
			// `breaker_trips_count` increment is observable via /health
			// (and the on-disk data/counters.json). The unit tests
			// exercise this directly; the production factory path was
			// missing the wire, so the runtime counter never bumped
			// under a real boot. Without this, the operator's
			// "how many times has OSS flapped this hour?" question
			// (the SLO behind the D018 / R010 breaker) is unanswerable.
			counters: opts && opts.counters !== undefined ? opts.counters : null,
		});
	}
	// "local" or unset — default backend. dataDir falls back to the
	// server's documented env-var name; the CLI passes it explicitly so
	// the helper does not have to import process.env in tests.
	const dataDir = opts && typeof opts.dataDir === "string" && opts.dataDir.length > 0
		? opts.dataDir
		: (env.MERMAID_RENDERER_DATA || "");
	return new _LocalFsStorage(dataDir, {
		counters: opts && opts.counters !== undefined ? opts.counters : null,
		logger: opts && opts.logger !== undefined ? opts.logger : null,
	});
}
