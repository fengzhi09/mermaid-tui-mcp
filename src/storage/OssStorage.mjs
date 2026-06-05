// src/storage/OssStorage.mjs — S3-compatible StorageBackend (M002 S01).
//
// Implements the StorageBackend interface (sealed in src/storage/Backend.mjs)
// over an S3-compatible object store using @aws-sdk/client-s3 (D016). The
// same code path covers AWS S3, MinIO (dev-time Docker target), and Aliyun
// OSS in S3-compat mode — the only differences between providers are
// (a) the endpoint URL, (b) the region, and (c) the credentials, all of
// which the env-construction helper OssStorageFromEnv reads from
// MERMAID_OSS_* env vars.
//
// T02 surface (this task):
//   - Full StorageBackend (13 methods) on OssStorage. The in-memory Map
//     index is the source of truth between save() calls; the S3
//     <prefix>/store.json is the persisted projection of that Map.
//   - _key(name) helper that joins prefix + name (no leading slash,
//     no trailing slash) so callers always get the right S3 key shape
//     even with non-empty prefixes.
//   - _logOp(command, key) helper that emits the oss_op structured
//     stderr line on every S3 call when a logger is attached, so an
//     operator can see what the renderer is doing to the bucket.
//   - _writeWithRetry(fn) helper that wraps every S3 PutObject /
//     DeleteObject call in the R017 retry policy: EAGAIN/EWOULDBLOCK
//     retry once, terminal / unknown errors wrap as StorageWriteError.
//   - readSvg() uses a 5s Promise.race timeout (R005) on top of the
//     SDK's own network timeout; on timeout throws StorageReadError;
//     on NoSuchKey returns null (LocalFsStorage parity).
//   - TTL_DAYS exported at the bottom (mirrors LocalFsStorage).
//
// Test seam: the constructor accepts a `client` option that can be any
// object with a `.send(command)` method. The unit tests pass a stub
// client that records every command and returns canned responses.
// The stub's `send` is duck-typed — the production code never imports
// any concrete command class, it imports them lazily via
// import("@aws-sdk/client-s3") at call sites so a stub that returns
// the right shape works without instantiating real commands.

import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

import { StorageReadError, StorageWriteError } from "../tools.mjs";

const READ_TIMEOUT_MS_DEFAULT = 5000; // mirrors LocalFsStorage's 5s read budget
const FORCE_PATH_STYLE_DEFAULT = true; // MinIO + Aliyun OSS S3-compat both need path-style
const PREFIX_DEFAULT = "";

const TTL_DAYS_DEFAULT = 7;
const TTL_MS_DEFAULT = TTL_DAYS_DEFAULT * 24 * 60 * 60 * 1000;
const SNIPPET_RADIUS = 30;
const SNIPPET_HARD_MAX = 80;

// Required MERMAID_OSS_* env vars. PREFIX and FORCE_PATH_STYLE are optional.
// The order is the order they are reported in the missing-var list, so it
// matches the human-grep-friendly env-var-name order in DECISIONS.md D016.
const REQUIRED_ENV_VARS = /** @type {const} */ ([
	"MERMAID_OSS_ENDPOINT",
	"MERMAID_OSS_REGION",
	"MERMAID_OSS_ACCESS_KEY_ID",
	"MERMAID_OSS_SECRET_ACCESS_KEY",
	"MERMAID_OSS_BUCKET",
]);

/**
 * Thrown by OssStorageFromEnv when one or more required env vars are
 * absent. The `.missing` array is a stable, ordered list of the absent
 * var names (matching REQUIRED_ENV_VARS order) so callers and tests can
 * produce a deterministic message without re-parsing the human text.
 *
 * The `code` is -32006 — same JSON-RPC-family range as StorageWriteError
 * (-32004) and StorageReadError (-32005); it is NOT mapped to the wire
 * by registerTools (env-construction happens at boot, before any tool
 * can run), so the code is purely for in-process distinguishability and
 * future observability extensions.
 */
export class OssEnvInvalidError extends Error {
	/**
	 * @param {string[]} missing  the absent required env var names
	 */
	constructor(missing) {
		super(`OssStorage env invalid; missing required vars: ${missing.join(", ")}`);
		this.name = "OssEnvInvalidError";
		this.code = -32006;
		this.missing = missing;
	}
}

// ---------------------------------------------------------------------------
// Test seam: the factory stores the S3Client it constructs in a
// module-level slot, exposed via __getLastClientForTesting(). The
// OssStorage instance also stores the client as this.client — that is
// the primary public surface (T02's methods will use it). The
// module-level seam is a backup for tests that want to assert the
// S3Client shape before the returned instance is captured, e.g. when
// the factory is tested in isolation. Initialised to null; the test
// reset path (`__resetLastClientForTesting()`) restores it.
// ---------------------------------------------------------------------------

/** @type {S3Client | null} */
let _lastClientForTesting = null;

/**
 * Return the S3Client that the most recent OssStorageFromEnv() call
 * constructed, or `null` if no factory call has happened yet. This is
 * the seam the unit tests use to verify bucket/prefix/client config
 * without introspecting the S3Client's private internals.
 *
 * @returns {S3Client | null}
 */
export function __getLastClientForTesting() {
	return _lastClientForTesting;
}

/**
 * Reset the test seam. Intended for the unit tests' afterEach hook so
 * one test's client does not leak into the next. Idempotent.
 */
export function __resetLastClientForTesting() {
	_lastClientForTesting = null;
}

// ---------------------------------------------------------------------------
// Pure helpers — mirror LocalFsStorage's buildSnippet / encodeCursor /
// decodeCursor. We copy them rather than refactor a shared seam (the
// snippet/cursor contracts are locked by the S02 tests; refactoring
// them is out of scope for M002).
// ---------------------------------------------------------------------------

/**
 * Build a 60-char-ish window around the first case-insensitive match
 * of `needle` in `haystack`, with the match wrapped in <mark> tags.
 * Pure-string (no HTML escape) — the consumer is an MCP tool handler,
 * not a browser.
 *
 * @param {string} haystack
 * @param {string} needle   pre-lowered
 * @returns {string}
 */
function buildSnippet(haystack, needle) {
	if (!needle) return "";
	const lower = haystack.toLowerCase();
	const idx = lower.indexOf(needle);
	if (idx < 0) return "";
	const start = Math.max(0, idx - SNIPPET_RADIUS);
	const end = Math.min(haystack.length, idx + needle.length + SNIPPET_RADIUS);
	const before = haystack.slice(start, idx);
	const match = haystack.slice(idx, idx + needle.length);
	const after = haystack.slice(idx + needle.length, end);
	let snippet = `${start > 0 ? "…" : ""}${before}<mark>${match}</mark>${after}${end < haystack.length ? "…" : ""}`;
	if (snippet.length > SNIPPET_HARD_MAX) snippet = snippet.slice(0, SNIPPET_HARD_MAX) + "…";
	return snippet;
}

/**
 * Encode / decode the opaque cursor for list() and search(). The cursor
 * is base64 of "{createdAt}:{id}" so it round-trips through JSON.
 *
 * @param {{createdAt: number, id: string}|null} pos
 * @returns {string|null}
 */
function encodeCursor(pos) {
	if (!pos) return null;
	return Buffer.from(`${pos.createdAt}:${pos.id}`, "utf-8").toString("base64");
}

/**
 * @param {string|null|undefined} cursor
 * @returns {{createdAt: number, id: string}|null}
 */
function decodeCursor(cursor) {
	if (!cursor) return null;
	try {
		const decoded = Buffer.from(cursor, "base64").toString("utf-8");
		const sep = decoded.indexOf(":");
		if (sep < 0) return null;
		const createdAt = Number.parseInt(decoded.slice(0, sep), 10);
		const id = decoded.slice(sep + 1);
		if (!Number.isFinite(createdAt) || !id) return null;
		return { createdAt, id };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// OssStorage class
// ---------------------------------------------------------------------------

export class OssStorage {
	/**
	 * @param {{
	 *   bucket: string,
	 *   prefix?: string,
	 *   client: S3Client,
	 *   counters?: import("../counters.mjs").Counters | null,
	 *   logger?: {log?: Function} | null,
	 *   readTimeoutMs?: number,
	 *   createBucket?: boolean,
	 * }} opts
	 */
	constructor(opts) {
		if (!opts || typeof opts !== "object") {
			throw new TypeError("OssStorage requires an options object");
		}
		const { bucket, prefix, client, counters, logger, readTimeoutMs, createBucket } = opts;
		if (typeof bucket !== "string" || bucket.length === 0) {
			throw new TypeError("OssStorage requires a non-empty bucket name");
		}
		// Duck-typed S3Client check: the production path passes a real
		// S3Client from @aws-sdk/client-s3, but the unit tests pass a
		// stub object that just exposes `.send(command) → Promise`. The
		// duck-type keeps the seam usable without forcing the test
		// fixtures to instantiate a real SDK client (which would force
		// them to mock the network, configure fake creds, etc.). The
		// oss-env.test.mjs "rejects non-S3Client inputs" case still
		// passes because `{ fake: true }` lacks a `.send` function.
		if (!client || typeof client !== "object" || typeof client.send !== "function") {
			throw new TypeError("OssStorage requires an S3Client instance (use OssStorageFromEnv to construct one)");
		}

		// root is the StorageBackend's "data dir or equivalent" field; for
		// OssStorage that opaque token is the bucket name. Consumers (the
		// 7 MCP tools, the /health route) read this through .stats() and
		// never dereference it directly, so swapping the type to a bucket
		// is invisible to the wire.
		this.root = bucket;
		this.bucket = bucket;
		this.prefix = typeof prefix === "string" ? prefix : PREFIX_DEFAULT;
		this.client = client;
		this.counters = counters ?? null;
		this.logger = logger ?? null;
		this.readTimeoutMs = typeof readTimeoutMs === "number" && readTimeoutMs > 0 ? readTimeoutMs : READ_TIMEOUT_MS_DEFAULT;
		// createBucket: when true, load() will CreateBucket on NoSuchBucket
		// (the dev-time MinIO path). When false (the AWS S3 production
		// default), the error propagates. The factory does NOT set this
		// — it's a per-instance toggle so a single OssStorage class
		// serves both "create-if-missing" dev mode and "fail-closed"
		// prod mode without env-var indirection.
		this.createBucket = typeof createBucket === "boolean" ? createBucket : false;

		// In-memory index — mirrors LocalFsStorage. load() / save() pair:
		// (a) scans the persisted index on load() and populates this Map,
		// (b) writes the serialized Map back to a single S3 key on save().
		// The put() / remove() / sweep() paths mutate the Map and persist
		// the index, the same way LocalFsStorage mutates and persists.
		/** @type {Map<string, import("./Backend.mjs").Entry>} */
		this.store = new Map();
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	/**
	 * Build the S3 key for a logical name (e.g. "store.json",
	 * "blobs/<id>.svg") honouring the configured prefix. An empty
	 * prefix returns the bare name; a non-empty prefix joins with a
	 * single "/" separator (no leading or trailing slashes).
	 *
	 * @param {string} name
	 * @returns {string}
	 */
	_key(name) {
		if (!this.prefix) return name;
		return `${this.prefix}/${name}`;
	}

	/**
	 * Emit the oss_op structured stderr line when a logger is attached.
	 * Silent no-op otherwise. The line shape (R008):
	 *   { ts, level, event, code?, id?, command, key, ...rest }
	 * `command` is the S3 command name (e.g. "GetObject"); `key` is
	 * the S3 object key. Errors are reported at level=error with the
	 * `error.message` attached; success lines are level=info.
	 *
	 * @param {string} command
	 * @param {string} key
	 * @param {{level?: "info"|"warn"|"error", rest?: object}} [opts]
	 */
	_logOp(command, key, opts = {}) {
		if (!this.logger || typeof this.logger.log !== "function") return;
		const level = opts.level || "info";
		const rest = opts.rest || {};
		try {
			this.logger.log({
				event: "oss_op",
				level,
				command,
				key,
				...rest,
			});
		} catch {
			// best-effort
		}
	}

	/**
	 * Wrap a single S3 write call in the R017 retry policy. On
	 * transient errors (S3 "ECONNRESET"-family or any error with
	 * .name === "TimeoutError") call fn() once more; on terminal
	 * errors (NoSuchBucket) or unknown errors throw StorageWriteError
	 * with the original message. On the retry path, bump the
	 * storage_write_retries counter (if attached).
	 *
	 * The S3 SDK has its own exponential-backoff retry layer for
	 * network errors; this layer is the project-standard R017 tagged
	 * error mapping on TOP of that, so the error path that reaches
	 * the user is a tagged StorageWriteError (-32004) with a clear
	 * message, not an opaque S3 SDK error.
	 *
	 * The retry is bounded to exactly one extra attempt — the second
	 * failure propagates verbatim (not re-classified, not re-wrapped),
	 * which means a permanent transient error surfaces as a raw
	 * timeout to the caller. The plan mandates "no second retry" so
	 * we honor that.
	 *
	 * @param {() => Promise<any>} fn
	 * @returns {Promise<any>}
	 */
	async _writeWithRetry(fn) {
		try {
			return await fn();
		} catch (firstErr) {
			const classification = _classifyWriteError(firstErr);
			if (classification === "transient") {
				if (this.counters) {
					await this.counters.increment("storage_write_retries");
				}
				return await fn();
			}
			const msg = firstErr && typeof firstErr === "object" && typeof firstErr.message === "string"
				? firstErr.message
				: String(firstErr);
			throw new StorageWriteError(msg);
		}
	}

	// -------------------------------------------------------------------------
	// StorageBackend surface
	// -------------------------------------------------------------------------

	/**
	 * Idempotent. Confirms the bucket exists (or creates it when
	 * createBucket=true), reads <prefix>/store.json into the in-memory
	 * Map, defaults legacy entry.title to "", and runs sweep() at the
	 * end (LocalFsStorage parity). When <prefix>/store.json is absent
	 * the store starts empty — same as a missing local store.json.
	 *
	 * @returns {Promise<void>}
	 */
	async load() {
		// Step 1: bucket existence check. HeadBucket fails with NoSuchBucket
		// when the bucket is missing. If createBucket is set, we recover
		// by calling CreateBucket and continuing; otherwise we propagate
		// the error to the caller (preserves the AWS S3 production
		// posture: a missing bucket is a real failure).
		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
		} catch (e) {
			const name = e && typeof e === "object" ? /** @type {any} */ (e).name : null;
			if (name === "NoSuchBucket" && this.createBucket) {
				await this._writeWithRetry(async () => {
					await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
				});
				this._logOp("CreateBucket", this.bucket, { level: "info", rest: { created: true } });
			} else {
				this._logOp("HeadBucket", this.bucket, { level: "error", rest: { error: e?.message } });
				throw e;
			}
		}
		this._logOp("HeadBucket", this.bucket, { level: "info" });

		// Step 2: read <prefix>/store.json. NoSuchKey → empty store
		// (LocalFsStorage parity: a missing store.json means the
		// storage has never been written to).
		const key = this._key("store.json");
		let obj;
		try {
			const res = await this._readObjectWithTimeout(key);
			obj = JSON.parse(res);
			this._logOp("GetObject", key, { level: "info" });
		} catch (e) {
			const name = e && typeof e === "object" ? /** @type {any} */ (e).name : null;
			if (name === "NoSuchKey") {
				obj = {};
				this._logOp("GetObject", key, { level: "info", rest: { empty: true } });
			} else if (e instanceof StorageReadError) {
				// Read timeout propagates as a tagged StorageReadError.
				this._logOp("GetObject", key, { level: "error", rest: { error: e.message } });
				throw e;
			} else {
				// Corrupted store.json — start fresh (LocalFsStorage parity).
				obj = {};
				this._logOp("GetObject", key, { level: "warn", rest: { error: e?.message, corrupted: true } });
			}
		}

		// Step 3: populate the in-memory Map, defaulting legacy
		// v0.1.0 entry.title to "" so the new code never sees
		// undefined.
		for (const [k, v] of Object.entries(obj)) {
			if (v && typeof v === "object" && typeof v.code === "string") {
				if (typeof v.title !== "string") v.title = "";
				this.store.set(k, v);
			}
		}

		// Step 4: sweep on load (LocalFsStorage parity — runs sweep
		// on every load() to drain expired entries that piled up while
		// the renderer was down).
		await this.sweep();
	}

	/**
	 * Wrap a GetObject call in a 5s Promise.race timeout. On timeout
	 * throws StorageReadError (-32005). On success returns the
	 * decoded body string. The S3 SDK has its own network timeouts;
	 * this is the R005 layer on top, so a hung SDK call still
	 * surfaces a tagged error within the 5s budget.
	 *
	 * @param {string} key
	 * @returns {Promise<string>}
	 */
	async _readObjectWithTimeout(key) {
		const timeoutMs = this.readTimeoutMs;
		/** @type {NodeJS.Timeout | undefined} */
		let timer;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new StorageReadError(`oss read timed out after ${timeoutMs}ms`)),
				timeoutMs,
			);
		});
		try {
			const sendPromise = this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			const result = await Promise.race([sendPromise, timeoutPromise]);
			clearTimeout(timer);
			const body = result && typeof result === "object" ? /** @type {any} */ (result).Body : null;
			if (!body || typeof body.transformToString !== "function") {
				// Defensive — a non-streaming body (e.g. a stub) should
				// expose transformToString for parity. If it doesn't, try
				// a direct string coercion as a fallback.
				if (typeof body === "string") return body;
				throw new StorageReadError("oss read returned a body without transformToString");
			}
			return await body.transformToString("utf-8");
		} catch (e) {
			clearTimeout(timer);
			throw e;
		}
	}

	/**
	 * @returns {Promise<void>}
	 */
	async save() {
		const obj = Object.fromEntries(this.store);
		const json = JSON.stringify(obj, null, 2);
		const key = this._key("store.json");
		await this._writeWithRetry(async () => {
			await this.client.send(new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: json,
				ContentType: "application/json",
			}));
		});
		this._logOp("PutObject", key, { level: "info" });
	}

	/**
	 * @returns {Promise<number>}  count of entries removed
	 */
	async sweep() {
		// R010: bump sweep_runs on every call (even if nothing is removed).
		if (this.counters) {
			await this.counters.increment("sweep_runs");
		}
		const now = Date.now();
		let removed = 0;
		for (const [id, entry] of [...this.store.entries()]) {
			if (!entry.pinned && now - entry.createdAt > TTL_MS_DEFAULT) {
				this.store.delete(id);
				// Best-effort DeleteObject on the blob (silent catch
				// mirrors sweep's local-fs unlink semantics — a missing
				// blob is not a sweep failure).
				const blobKey = this._key(`blobs/${id}.svg`);
				try {
					await this._writeWithRetry(async () => {
						await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey }));
					});
					this._logOp("DeleteObject", blobKey, { level: "info", rest: { sweep: true } });
				} catch {
					// best-effort
				}
				removed++;
			}
		}
		if (removed > 0) {
			if (this.counters) {
				for (let i = 0; i < removed; i++) {
					await this.counters.increment("sweep_removed");
				}
			}
			await this.save();
		}
		return removed;
	}

	/**
	 * @param {string} id
	 * @param {string} code
	 * @param {string} svg
	 * @param {number} sourceLength
	 * @param {string} [title]
	 * @returns {Promise<import("./Backend.mjs").Entry>}
	 */
	async put(id, code, svg, sourceLength, title) {
		const entry = {
			code,
			createdAt: Date.now(),
			pinned: false,
			lastAccessedAt: Date.now(),
			sourceLength: typeof sourceLength === "number" ? sourceLength : code.length,
			title: typeof title === "string" ? title : "",
		};
		this.store.set(id, entry);
		const blobKey = this._key(`blobs/${id}.svg`);
		await this._writeWithRetry(async () => {
			await this.client.send(new PutObjectCommand({
				Bucket: this.bucket,
				Key: blobKey,
				Body: svg,
				ContentType: "image/svg+xml",
			}));
		});
		this._logOp("PutObject", blobKey, { level: "info", rest: { id } });
		await this.save();
		return entry;
	}

	/**
	 * @param {string} id
	 * @returns {boolean}
	 */
	has(id) {
		return this.store.has(id);
	}

	/**
	 * @param {string} id
	 * @returns {import("./Backend.mjs").Entry|null}
	 */
	getMetadata(id) {
		const entry = this.store.get(id);
		return entry ? entry : null;
	}

	/**
	 * @param {string} id
	 * @returns {Promise<string|null>}
	 */
	async readSvg(id) {
		const blobKey = this._key(`blobs/${id}.svg`);
		try {
			const svg = await this._readObjectWithTimeout(blobKey);
			this._logOp("GetObject", blobKey, { level: "info", rest: { id } });
			return svg;
		} catch (e) {
			const name = e && typeof e === "object" ? /** @type {any} */ (e).name : null;
			if (name === "NoSuchKey") {
				// LocalFsStorage parity — a missing blob == missing entry.
				this._logOp("GetObject", blobKey, { level: "info", rest: { id, missing: true } });
				return null;
			}
			if (e instanceof StorageReadError) {
				this._logOp("GetObject", blobKey, { level: "error", rest: { id, error: e.message } });
				throw e;
			}
			this._logOp("GetObject", blobKey, { level: "error", rest: { id, error: e?.message } });
			throw e;
		}
	}

	/**
	 * @param {string} id
	 * @param {boolean} pinned
	 * @returns {Promise<boolean>}
	 */
	async setPinned(id, pinned) {
		const entry = this.store.get(id);
		if (!entry) return false;
		entry.pinned = !!pinned;
		await this.save();
		return true;
	}

	/**
	 * @param {string} id
	 * @returns {Promise<boolean>}
	 */
	async remove(id) {
		const entry = this.store.get(id);
		if (!entry) return false;
		this.store.delete(id);
		// Best-effort DeleteObject on the blob (silent catch mirrors
		// sweep's local-fs unlink semantics).
		const blobKey = this._key(`blobs/${id}.svg`);
		try {
			await this._writeWithRetry(async () => {
				await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey }));
			});
			this._logOp("DeleteObject", blobKey, { level: "info", rest: { id } });
		} catch {
			// best-effort
		}
		await this.save();
		return true;
	}

	/**
	 * @param {{limit?: number, cursor?: string, pinned?: boolean}} [opts]
	 * @returns {Promise<import("./Backend.mjs").ListResult>}
	 */
	async list(opts = {}) {
		const limitRaw = opts.limit == null ? 20 : opts.limit;
		const limit = Math.min(100, Math.max(1, Math.floor(limitRaw)));
		const cursorPos = decodeCursor(opts.cursor);
		const pinnedFilter = typeof opts.pinned === "boolean" ? opts.pinned : null;

		const all = [...this.store.entries()]
			.filter(([, e]) => (pinnedFilter == null ? true : e.pinned === pinnedFilter))
			.sort((a, b) => {
				if (b[1].createdAt !== a[1].createdAt) return b[1].createdAt - a[1].createdAt;
				return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
			});

		let startIdx = 0;
		if (cursorPos) {
			const foundAt = all.findIndex(([id, e]) => e.createdAt === cursorPos.createdAt && id === cursorPos.id);
			if (foundAt >= 0) startIdx = foundAt + 1;
		}

		const page = all.slice(startIdx, startIdx + limit);
		const hasMore = startIdx + limit < all.length;
		const last = page[page.length - 1];
		const nextCursor = hasMore && last ? encodeCursor({ createdAt: last[1].createdAt, id: last[0] }) : null;

		// MEM024 fix: project {id, ...entry} so the caller can
		// pin/get/delete by reference.
		return {
			items: page.map(([id, e]) => ({ id, ...e })),
			nextCursor,
		};
	}

	/**
	 * @param {string} query
	 * @param {{limit?: number, cursor?: string, pinned?: boolean}} [opts]
	 * @returns {import("./Backend.mjs").SearchResult}
	 */
	search(query, opts = {}) {
		const q = (query || "").toLowerCase();
		const limitRaw = opts.limit == null ? 20 : opts.limit;
		const limit = Math.min(100, Math.max(1, Math.floor(limitRaw)));
		const cursorPos = decodeCursor(opts.cursor);
		const pinnedFilter = typeof opts.pinned === "boolean" ? opts.pinned : null;

		const all = [...this.store.entries()].filter(([, e]) => (pinnedFilter == null ? true : e.pinned === pinnedFilter));

		/** @type {Array<{id: string, entry: import("./Backend.mjs").Entry, titleMatch: boolean, snippet: string}>} */
		const matched = [];
		for (const [id, e] of all) {
			const title = (e.title || "").toLowerCase();
			const code = (e.code || "").toLowerCase();
			let titleMatch = false;
			let hitField = null;
			if (q && title.includes(q)) {
				titleMatch = true;
				hitField = e.title || "";
			} else if (q && code.includes(q)) {
				hitField = e.code || "";
			} else {
				continue;
			}
			matched.push({ id, entry: e, titleMatch, snippet: buildSnippet(hitField, q) });
		}

		matched.sort((a, b) => {
			if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
			if (b.entry.createdAt !== a.entry.createdAt) return b.entry.createdAt - a.entry.createdAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

		let startIdx = 0;
		if (cursorPos) {
			const foundAt = matched.findIndex((m) => m.entry.createdAt === cursorPos.createdAt && m.id === cursorPos.id);
			if (foundAt >= 0) startIdx = foundAt + 1;
		}

		const pageRaw = matched.slice(startIdx, startIdx + limit);
		const hasMore = startIdx + limit < matched.length;
		const last = pageRaw[pageRaw.length - 1];
		const nextCursor = hasMore && last ? encodeCursor({ createdAt: last.entry.createdAt, id: last.id }) : null;

		// MEM024 fix: project {id, ...entry, titleMatch, snippet}.
		return {
			items: pageRaw.map((m) => ({ id: m.id, ...m.entry, titleMatch: m.titleMatch, snippet: m.snippet })),
			nextCursor,
		};
	}

	/**
	 * @returns {{total: number, pinned: number, unpinned: number}}
	 */
	stats() {
		let pinned = 0;
		for (const e of this.store.values()) if (e.pinned) pinned++;
		return { total: this.store.size, pinned, unpinned: this.store.size - pinned };
	}

	/**
	 * @param {string} id
	 * @returns {Promise<import("./Backend.mjs").Entry|null>}
	 */
	async pruneIfExpired(id) {
		const entry = this.store.get(id);
		if (!entry) return null;
		if (!entry.pinned && Date.now() - entry.createdAt > TTL_MS_DEFAULT) {
			this.store.delete(id);
			const blobKey = this._key(`blobs/${id}.svg`);
			try {
				await this._writeWithRetry(async () => {
					await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: blobKey }));
				});
				this._logOp("DeleteObject", blobKey, { level: "info", rest: { id, prune: true } });
			} catch {
				// best-effort
			}
			await this.save();
			return null;
		}
		entry.lastAccessedAt = Date.now();
		return entry;
	}
}

export const TTL_DAYS = TTL_DAYS_DEFAULT;

// ---------------------------------------------------------------------------
// Module-level helpers (intentionally not on the class — they're pure
// functions of the thrown error, not of the storage state).
// ---------------------------------------------------------------------------

/**
 * Classify an S3 call failure into the R017 buckets:
 *   - "transient": SDK network errors, timeouts — retry once
 *   - "terminal":  NoSuchBucket, NoSuchKey, AccessDenied — no retry, surface as-is
 *                  (NoSuchKey is a legitimate miss for readSvg, so the
 *                  caller pattern-matches on the error name and returns
 *                  null — we never retry, never wrap.)
 *   - "unknown":   anything else — no retry, surface StorageWriteError
 *
 * The S3 SDK has its own internal retry layer for network errors
 * (ECONNRESET, ETIMEDOUT, etc.) which surfaces as a TimeoutError after
 * exhaustion; we re-classify that as transient so a second attempt
 * gets one more chance before the tagged StorageWriteError propagates.
 *
 * @param {unknown} err
 * @returns {"transient" | "terminal" | "unknown"}
 */
function _classifyWriteError(err) {
	if (!err || typeof err !== "object") return "unknown";
	const name = /** @type {any} */ (err).name;
	const code = /** @type {any} */ (err).code;
	if (name === "TimeoutError" || name === "TimeoutException" || name === "RequestTimeout") return "transient";
	if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EAI_AGAIN") return "transient";
	if (name === "NoSuchBucket" || name === "NoSuchKey" || name === "AccessDenied") return "terminal";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Env-construction helper
// ---------------------------------------------------------------------------

/**
 * Build a fully-wired OssStorage from the MERMAID_OSS_* env vars. Pure
 * function of its inputs (no process-state mutation, no I/O) so the
 * unit tests can pass a plain object literal as `env` and assert on
 * the result without unsetting/restoring real env vars.
 *
 * Required env vars (throws OssEnvInvalidError if any are absent):
 *   MERMAID_OSS_ENDPOINT        — http(s)://host:port of the S3-compatible endpoint
 *   MERMAID_OSS_REGION          — region string (e.g. "us-east-1", "cn-hangzhou")
 *   MERMAID_OSS_ACCESS_KEY_ID   — S3 access key
 *   MERMAID_OSS_SECRET_ACCESS_KEY — S3 secret
 *   MERMAID_OSS_BUCKET          — bucket name
 *
 * Optional env vars (defaulted silently):
 *   MERMAID_OSS_PREFIX          — key prefix; "" if absent. Useful when
 *                                  sharing a bucket across multiple
 *                                  mermaid-tui-mcp instances.
 *   MERMAID_OSS_FORCE_PATH_STYLE — "0" / "false" / "no" → false; anything
 *                                  else (including absent) → true. MinIO
 *                                  and Aliyun OSS S3-compat both need
 *                                  path-style; real AWS S3 also accepts
 *                                  path-style with this flag, so the
 *                                  default is path-style.
 *
 * Observability:
 *   On missing-var failure, emits a structured stderr `oss_env_invalid`
 *   log line (R008) with the ordered missing-var list BEFORE throwing,
 *   so the operator's log shipper sees the rejection even if the
 *   caller swallows the exception. The `level: "error"` is reserved
 *   for fatal boot failures; this is a boot-blocking configuration
 *   error so error is the right level.
 *
 * @param {Record<string, string | undefined>} [env]   defaults to process.env
 * @param {{
 *   counters?: import("../counters.mjs").Counters | null,
 *   logger?: {log?: Function} | null,
 *   readTimeoutMs?: number,
 *   forcePathStyle?: boolean,
 *   createBucket?: boolean,
 * }} [opts]   extra wiring passed through to OssStorage
 * @returns {OssStorage}
 */
export function OssStorageFromEnv(env, opts = {}) {
	const src = env || process.env;

	// Collect the missing-var list in REQUIRED_ENV_VARS order so the
	// reported order is stable across runs (matters for tests that
	// assert the exact order, and for the deterministic log line).
	const missing = [];
	for (const name of REQUIRED_ENV_VARS) {
		const v = src[name];
		if (typeof v !== "string" || v.length === 0) {
			missing.push(name);
		}
	}

	if (missing.length > 0) {
		// Emit the structured log line BEFORE throwing. Use a defensive
		// log() shape so the call site that does not pass a logger still
		// gets an observability surface — fall back to writing a JSON
		// line to stderr directly if opts.logger is absent.
		const logLine = {
			level: "error",
			event: "oss_env_invalid",
			missing,
		};
		const logger = opts && opts.logger;
		if (logger && typeof logger.log === "function") {
			try {
				logger.log(logLine);
			} catch {
				// best-effort
			}
		} else {
			try {
				process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...logLine }) + "\n");
			} catch {
				// best-effort
			}
		}
		throw new OssEnvInvalidError(missing);
	}

	const endpoint = /** @type {string} */ (src.MERMAID_OSS_ENDPOINT);
	const region = /** @type {string} */ (src.MERMAID_OSS_REGION);
	const accessKeyId = /** @type {string} */ (src.MERMAID_OSS_ACCESS_KEY_ID);
	const secretAccessKey = /** @type {string} */ (src.MERMAID_OSS_SECRET_ACCESS_KEY);
	const bucket = /** @type {string} */ (src.MERMAID_OSS_BUCKET);

	const prefix = typeof src.MERMAID_OSS_PREFIX === "string" && src.MERMAID_OSS_PREFIX.length > 0 ? src.MERMAID_OSS_PREFIX : PREFIX_DEFAULT;

	// FORCE_PATH_STYLE parsing. Anything other than "0"/"false"/"no"
	// (case-insensitive) is treated as truthy. The default of true is
	// correct for MinIO + Aliyun OSS S3-compat; real AWS S3 also accepts
	// path-style with this flag, so there is no scenario in M002's
	// target list where the default is wrong.
	const forcePathStyleRaw = src.MERMAID_OSS_FORCE_PATH_STYLE;
	let forcePathStyle = FORCE_PATH_STYLE_DEFAULT;
	if (typeof forcePathStyleRaw === "string" && forcePathStyleRaw.length > 0) {
		const norm = forcePathStyleRaw.trim().toLowerCase();
		if (norm === "0" || norm === "false" || norm === "no") {
			forcePathStyle = false;
		} else {
			forcePathStyle = true;
		}
	}
	// The explicit `forcePathStyle` opt in OssStorageFromEnv opts
	// overrides the env-var resolution — this matches the LocalFsStorage
	// pattern of accepting an explicit opt even when a default exists.
	if (opts && typeof opts.forcePathStyle === "boolean") {
		forcePathStyle = opts.forcePathStyle;
	}

	// Construct the S3Client. The endpoint is passed verbatim; the SDK
	// normalizes trailing slashes internally.
	const client = new S3Client({
		region,
		endpoint,
		forcePathStyle,
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
	});
	_lastClientForTesting = client;

	return new OssStorage({
		bucket,
		prefix,
		client,
		counters: opts && opts.counters !== undefined ? opts.counters : null,
		logger: opts && opts.logger !== undefined ? opts.logger : null,
		readTimeoutMs: opts && typeof opts.readTimeoutMs === "number" ? opts.readTimeoutMs : READ_TIMEOUT_MS_DEFAULT,
		createBucket: opts && typeof opts.createBucket === "boolean" ? opts.createBucket : false,
	});
}

// Re-export the two tagged error classes for callers that want to
// import them from the storage module (mirrors the
// src/storage/LocalFsStorage.mjs pattern of re-exporting TTL_DAYS at
// the bottom of the file).
export { StorageReadError, StorageWriteError };
