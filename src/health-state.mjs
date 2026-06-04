// src/health-state.mjs — in-memory health-state holder for the S03 /health
// extension (R009).
//
// Two surfaces:
//   1. last_render_ms — wall-clock ms of the last tool call, regardless
//      of which tool or whether it succeeded. Updated on every
//      registerTools wrapper invocation. /health returns the latest
//      value; defaults to 0 when no tool has been called yet.
//   2. last_errors[5] — a 5-element FIFO ring buffer of the most recent
//      tagged error events. Each entry is {code, at, retryable, message}
//      where `at` is the wall-clock epoch ms at record time. The buffer
//      drops the oldest entry when a 6th is recorded (FIFO). /health
//      always returns the array, even when empty — never undefined.
//
// State is process-local. On restart, both reset to defaults. This is
// intentional — the persistent error history lives in data/counters.json
// (the 6 monotonic counters) and the structured stderr log stream; the
// ring is for live operator visibility, not durability.

const RING_CAPACITY = 5;

/** @type {Array<{code: number, at: number, retryable: boolean, message: string}>} */
const _ring = [];
let _lastRenderMs = 0;

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
 * Return a deep-copy snapshot of the health state for /health. Both
 * fields are always present: last_render_ms is a number (default 0);
 * last_errors is an array (possibly empty, never undefined). The ring
 * is copied so the /health response can be JSON.stringified without
 * exposing the live array to mutation.
 *
 * @returns {{last_render_ms: number, last_errors: Array<{code: number, at: number, retryable: boolean, message: string}>}}
 */
export function snapshot() {
	return {
		last_render_ms: _lastRenderMs,
		last_errors: _ring.map((e) => ({ code: e.code, at: e.at, retryable: e.retryable, message: e.message })),
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
}
