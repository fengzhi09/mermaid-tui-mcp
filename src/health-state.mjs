// src/health-state.mjs — in-memory health-state holder for the S03 /health
// extension (R009, T04).
//
// Surfaces:
//   1. last_render_ms — wall-clock ms of the last tool call, regardless
//      of which tool or whether it succeeded. Updated on every
//      registerTools wrapper invocation. /health returns the latest
//      value; defaults to 0 when no tool has been called yet.
//   2. last_errors[5] — a 5-element FIFO ring buffer of the most recent
//      tagged error events. Each entry is {code, at, retryable, message}
//      where `at` is the wall-clock epoch ms at record time. The buffer
//      drops the oldest entry when a 6th is recorded (FIFO). /health
//      always returns the array, even when empty — never undefined.
//   3. last_oss_failure ({ts, code, msg} | null) — the most recent OSS
//      failure's tagged error shape, recorded by:
//        a) server.mjs boot path: when the OssEnvInvalidError path is
//           hit (T01), setBootOssFailure({ts: Date.now(), code: -32006,
//           msg: <error text>}) writes a single record before any tool
//           call has been made.
//        b) OssStorage.recordFailure: every runtime failure (T02) stores
//           {message, at, code} on this.breaker.lastFailure; the
//           /health handler maps the storage field to {ts, code, msg}
//           shape when assembling the response.
//      The two paths are merged by the /health handler with this
//      priority: if boot-degraded recorded a value, that wins (it was
//      the first observed failure of this server lifetime, and
//      represents the configured-but-not-usable OSS path).
//   4. boot_degraded (boolean) — true iff the boot path fell back to
//      LocalFsStorage because the env-driven OssStorageFromEnv factory
//      threw OssEnvInvalidError. Set exactly once at boot, never reset.
//      /health.backend uses this to surface "degraded" even though the
//      storage is now a pure LocalFsStorage (no .health() method to
//      inspect).
//
// State is process-local. On restart, all reset to defaults. This is
// intentional — the persistent error history lives in data/counters.json
// (the 6+2 monotonic counters) and the structured stderr log stream;
// this module is for live operator visibility, not durability.

const RING_CAPACITY = 5;

/** @type {Array<{code: number, at: number, retryable: boolean, message: string}>} */
const _ring = [];
let _lastRenderMs = 0;

/** @type {{ts: number, code: number | string, msg: string} | null} */
let _bootOssFailure = null;
let _bootDegraded = false;

/**
 * Push a new error onto the ring. Drops the oldest entry when at capacity.
 *
 * @param {{code: number, retryable: boolean, message: string}} entry
 */
export function recordError(entry) {
	const code = typeof entry?.code === "number" ? entry.code : 0;
	const retryable = !!entry?.retryable;
	const message = typeof entry?.message === "string" ? entry.message : String(entry?.message ?? "");
	const at = Date.now();
	_ring.push({ code, at, retryable, message });
	if (_ring.length > RING_CAPACITY) {
		_ring.shift(); // drop the oldest
	}
}

/**
 * Set the last-render-ms marker (called by the registerTools wrapper on
 * every tool call).
 *
 * @param {number} ms
 */
export function setLastRenderMs(ms) {
	_lastRenderMs = typeof ms === "number" && Number.isFinite(ms) ? ms : 0;
}

/**
 * @returns {number} the last-render-ms marker (0 if no tool call yet)
 */
export function getLastRenderMs() {
	return _lastRenderMs;
}

/**
 * Mark the boot path as degraded (D017). Called exactly once at boot
 * when src/server.mjs catches OssEnvInvalidError from the
 * OssStorageFromEnv factory and falls back to LocalFsStorage. The
 * /health handler reads this to surface `backend: "degraded"` even
 * though the runtime storage is a pure LocalFsStorage (no .health()
 * method on which to introspect the breaker's state).
 *
 * Idempotent — a second call with the same value is a no-op. A second
 * call with `false` is also accepted (test seam); the production path
 * only ever sets it true.
 *
 * @param {boolean} value
 */
export function setBootDegraded(value) {
	_bootDegraded = !!value;
}

/**
 * @returns {boolean} whether the boot fell back to local due to an
 *   OssEnvInvalidError. False on a clean boot.
 */
export function isBootDegraded() {
	return _bootDegraded;
}

/**
 * Record the most recent OSS failure's tagged error shape. Called
 * from server.mjs's boot-degraded path (T01 caught OssEnvInvalidError)
 * with the canonical {ts, code, msg} payload. The /health handler
 * prefers this value over OssStorage.breaker.lastFailure when both
 * are set, because the boot failure happened FIRST in the server's
 * lifetime and represents the configured-but-not-usable OSS path.
 *
 * The same shape is exposed at top-level `last_oss_failure` in the
 * /health response. Subsequent calls overwrite (the ring is the
 * `last_errors[5]` field; this is a single-record slot, not a ring).
 *
 * @param {{ts: number, code: number | string, msg: string}} entry
 */
export function setBootOssFailure(entry) {
	if (!entry || typeof entry !== "object") {
		_bootOssFailure = null;
		return;
	}
	const ts = typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : Date.now();
	const code = entry.code ?? null;
	const msg = typeof entry.msg === "string" ? entry.msg : String(entry.msg ?? "");
	_bootOssFailure = { ts, code, msg };
}

/**
 * @returns {{ts: number, code: number | string, msg: string} | null}
 *   the recorded boot-time OSS failure, or null if the boot path
 *   didn't degrade.
 */
export function getBootOssFailure() {
	return _bootOssFailure;
}

/**
 * Return a deep-copy snapshot of the health state for /health. All
 * four fields are always present: last_render_ms is a number (default
 * 0); last_errors is an array (possibly empty, never undefined);
 * last_oss_failure is the {ts, code, msg} object or null; boot_degraded
 * is a boolean. The ring and the failure record are deep-copied so the
 * /health response can be JSON.stringified without exposing the live
 * references to mutation.
 *
 * @returns {{
 *   last_render_ms: number,
 *   last_errors: Array<{code: number, at: number, retryable: boolean, message: string}>,
 *   last_oss_failure: {ts: number, code: number | string, msg: string} | null,
 *   boot_degraded: boolean,
 * }}
 */
export function snapshot() {
	return {
		last_render_ms: _lastRenderMs,
		last_errors: _ring.map((e) => ({ code: e.code, at: e.at, retryable: e.retryable, message: e.message })),
		last_oss_failure: _bootOssFailure ? { ts: _bootOssFailure.ts, code: _bootOssFailure.code, msg: _bootOssFailure.msg } : null,
		boot_degraded: _bootDegraded,
	};
}

/**
 * Reset all in-memory state. Used by tests to start from a known baseline
 * (vitest runs in a single process; the module-level state would leak
 * between tests otherwise).
 */
export function __resetHealthStateForTesting() {
	_ring.length = 0;
	_lastRenderMs = 0;
	_bootOssFailure = null;
	_bootDegraded = false;
}
