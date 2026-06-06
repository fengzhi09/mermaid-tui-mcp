// tests/unit/degradable-storage.test.mjs — unit tests for src/storage/DegradableStorage.mjs.
//
// S03 T03 contract: the wrapper delegates to the OssStorage.breaker state
// machine (added in T02). The wrapper itself does NOT keep its own
// degraded/failureCount state — single source of truth on `primary.breaker`.
//
// Coverage (12 it()s, per the T03 plan: 透传 / 失败切回 / 半开探测 / 计数器 / 事件):
//
//   passthrough (透传):
//     1. default state (threshold=3, halfOpenAfterMs=60000, root=fallback.root)
//     2. root returns fallback.root (T03 contract change vs D018)
//     3. sync methods (has / stats / search / getMetadata) route to primary
//        in normal state
//     4. sync methods route to fallback when primary is open (degraded)
//
//   failure → fallback (失败切回):
//     5. async put: primary success → no fallback call, no recordFailure
//     6. async put: primary fail → fallback called + recordFailure
//        (1 failure, not yet open)
//
//   breaker trip (熔断):
//     7. 3 consecutive failures trip the breaker (state=open)
//     8. on trip: emit breaker_open (level=warn) + bump breaker_trips_count
//     9. after trip, subsequent calls skip primary (go straight to fallback)
//
//   half-open probe (半开探测):
//    10. past window: primary is called (probe)
//    11. probe success: recordSuccess + emit breaker_close (level=info)
//    12. probe failure: recordFailure + cool-down extended, no second
//        breaker_open event (just one warning for the actual transition)

import { describe, expect, it, vi } from "vitest";

import { DegradableStorage } from "../../src/storage/DegradableStorage.mjs";
import { Counters } from "../../src/counters.mjs";

// ---------------------------------------------------------------------------
// makeStubPrimary — a BreakerBackedStorage stub that mirrors the real
// OssStorage interface (13 methods + breaker + canAttempt/recordFailure/
// recordSuccess). The breaker state machine here is a real implementation
// (same transitions as OssStorage) so the wrapper's recordFailure /
// recordSuccess calls are observed end-to-end.
//
// Test controls:
//   - breakerOverride: partial breaker state to seed (e.g. { state: "open",
//     openedAt: Date.now() - 100 } to force "open + past window")
//   - failNext: an array of {op, error} pairs; the stub will throw the
//     error the next time `op` is called, then remove the entry (one-shot).
//   - failOpForever: a {op, error} object; the stub will throw `error` on
//     every call to `op` until cleared.
// ---------------------------------------------------------------------------

function makeStubPrimary(name, overrides = {}) {
	const breaker = {
		state: "closed",
		failureCount: 0,
		lastFailure: null,
		openedAt: null,
		threshold: 3,
		halfOpenAfterMs: 60_000,
		...(overrides.breakerOverride || {}),
	};
	/** @type {Array<{op: string, error: Error}>} */
	const failNext = [];
	/** @type {{op: string, error: Error} | null} */
	let failOpForever = null;

	const stub = {
		name,
		root: "/stub/primary/" + name,
		breaker,
		// -- state machine (mirrors OssStorage.breaker.canAttempt) --
		canAttempt: vi.fn(() => {
			if (breaker.state === "closed") return true;
			if (breaker.state === "open") {
				if (breaker.openedAt == null) return false;
				return Date.now() - breaker.openedAt > breaker.halfOpenAfterMs;
			}
			return false;
		}),
		recordFailure: vi.fn((err) => {
			const message = err && typeof err === "object" && typeof err.message === "string"
				? err.message
				: String(err);
			breaker.failureCount += 1;
			breaker.lastFailure = { message, at: Date.now() };
			const reachedThreshold = breaker.failureCount >= breaker.threshold;
			if (reachedThreshold) {
				const wasClosed = breaker.state === "closed";
				breaker.state = "open";
				breaker.openedAt = Date.now();
				return { state: breaker.state, failureCount: breaker.failureCount, opened: wasClosed };
			}
			return { state: breaker.state, failureCount: breaker.failureCount, opened: false };
		}),
		recordSuccess: vi.fn(() => {
			breaker.failureCount = 0;
			breaker.state = "closed";
			breaker.openedAt = null;
			breaker.lastFailure = null;
			return { state: breaker.state, failureCount: breaker.failureCount };
		}),
		// -- storage methods (sync) --
		has: vi.fn(() => false),
		getMetadata: vi.fn(() => null),
		stats: vi.fn(() => ({ total: 0, pinned: 0, unpinned: 0 })),
		search: vi.fn(() => ({ items: [], nextCursor: null })),
		// -- storage methods (async) --
		load: vi.fn(async () => {}),
		save: vi.fn(async () => {}),
		sweep: vi.fn(async () => 0),
		put: vi.fn(async (id, code, svg) => ({ id, code, svg, createdAt: 0, pinned: false, lastAccessedAt: 0, sourceLength: code.length, title: "" })),
		readSvg: vi.fn(async () => "<svg/>"),
		setPinned: vi.fn(async () => true),
		remove: vi.fn(async () => true),
		list: vi.fn(async () => ({ items: [], nextCursor: null })),
		pruneIfExpired: vi.fn(async () => null),
	};

	// Helper: when an op is called, consume the matching failNext /
	// failOpForever entry. Used by all async methods below.
	function _checkFail(op) {
		const idx = failNext.findIndex((f) => f.op === op);
		if (idx >= 0) {
			const f = failNext[idx];
			failNext.splice(idx, 1);
			throw f.error;
		}
		if (failOpForever && failOpForever.op === op) {
			throw failOpForever.error;
		}
	}

	// Wrap each async method so it honours the failNext / failOpForever
	// queues. The sync methods are NOT wrapped (they don't throw network
	// errors in our test scenarios).
	stub.load = vi.fn(async () => { _checkFail("load"); });
	stub.save = vi.fn(async () => { _checkFail("save"); });
	stub.sweep = vi.fn(async () => { _checkFail("sweep"); return 0; });
	stub.put = vi.fn(async (id, code, svg, sl, title) => {
		_checkFail("put");
		return { id, code, svg, createdAt: 0, pinned: false, lastAccessedAt: 0, sourceLength: sl, title: title || "" };
	});
	stub.readSvg = vi.fn(async (id) => {
		_checkFail("readSvg");
		return "<svg/>";
	});
	stub.setPinned = vi.fn(async (id, pinned) => {
		_checkFail("setPinned");
		return true;
	});
	stub.remove = vi.fn(async (id) => {
		_checkFail("remove");
		return true;
	});
	stub.list = vi.fn(async (opts) => {
		_checkFail("list");
		return { items: [], nextCursor: null };
	});
	stub.pruneIfExpired = vi.fn(async (id) => {
		_checkFail("pruneIfExpired");
		return null;
	});

	// Test controls exposed for direct queue manipulation.
	stub._controls = {
		failNext(op, error) { failNext.push({ op, error }); },
		failOpForever(op, error) { failOpForever = { op, error }; },
		clearForever() { failOpForever = null; },
		get breaker() { return breaker; },
	};

	return stub;
}

// ---------------------------------------------------------------------------
// makeStubFallback — a plain StorageBackend stub (no breaker). Records
// every call so tests can assert on the fallback's call sequence.
// ---------------------------------------------------------------------------

function makeStubFallback(name) {
	const stub = {
		name,
		root: "/stub/fallback/" + name,
		has: vi.fn(() => false),
		getMetadata: vi.fn(() => null),
		stats: vi.fn(() => ({ total: 0, pinned: 0, unpinned: 0 })),
		search: vi.fn(() => ({ items: [], nextCursor: null })),
		load: vi.fn(async () => {}),
		save: vi.fn(async () => {}),
		sweep: vi.fn(async () => 0),
		put: vi.fn(async (id, code, svg) => ({ id, code, svg, createdAt: 0, pinned: false, lastAccessedAt: 0, sourceLength: code.length, title: "" })),
		readSvg: vi.fn(async () => "<svg-fallback/>"),
		setPinned: vi.fn(async () => true),
		remove: vi.fn(async () => true),
		list: vi.fn(async () => ({ items: [], nextCursor: null })),
		pruneIfExpired: vi.fn(async () => null),
	};
	return stub;
}

describe("DegradableStorage (M003/S03/T03 — OssStorage.breaker-driven wrapper)", () => {
	// -----------------------------------------------------------------------
	// 1. Default state
	// -----------------------------------------------------------------------
	it("default state: threshold=3, halfOpenAfterMs=60000, breaker closed, root=fallback.root", () => {
		const primary = makeStubPrimary("p");
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback);
		// Defaults written through to primary.breaker.
		expect(primary.breaker.threshold).toBe(3);
		expect(primary.breaker.halfOpenAfterMs).toBe(60_000);
		expect(primary.breaker.state).toBe("closed");
		expect(primary.breaker.failureCount).toBe(0);
		// root: T03 contract — fallback.root (不是 primary.root).
		expect(ds.root).toBe("/stub/fallback/f");
		// health(): fully populated.
		const h = ds.health();
		expect(h.degraded).toBe(false);
		expect(h.breaker_state).toBe("closed");
		expect(h.consecutive_failures).toBe(0);
		expect(h.failure_threshold).toBe(3);
		expect(h.half_open_after_ms).toBe(60_000);
		expect(h.opened_at).toBeNull();
		expect(h.last_failure).toBeNull();
		expect(h.primary_root).toBe("/stub/primary/p");
		expect(h.fallback_root).toBe("/stub/fallback/f");
	});

	// -----------------------------------------------------------------------
	// 2. Constructor: opts.threshold / opts.halfOpenAfterMs override
	// -----------------------------------------------------------------------
	it("constructor opts.threshold + opts.halfOpenAfterMs override the defaults", () => {
		const primary = makeStubPrimary("p");
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback, { threshold: 2, halfOpenAfterMs: 5000 });
		expect(ds.health().failure_threshold).toBe(2);
		expect(ds.health().half_open_after_ms).toBe(5000);
		// Applied to primary.breaker (the state machine the wrapper drives).
		expect(primary.breaker.threshold).toBe(2);
		expect(primary.breaker.halfOpenAfterMs).toBe(5000);
	});

	// -----------------------------------------------------------------------
	// 3. Sync methods route to primary in normal state
	// -----------------------------------------------------------------------
	it("sync methods (has / stats / search / getMetadata) route to primary in normal state", () => {
		const primary = makeStubPrimary("p");
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback);
		ds.has("i1");
		ds.stats();
		ds.search("q");
		ds.getMetadata("i1");
		expect(primary.has).toHaveBeenCalledWith("i1");
		expect(primary.stats).toHaveBeenCalled();
		expect(primary.search).toHaveBeenCalledWith("q", undefined);
		expect(primary.getMetadata).toHaveBeenCalledWith("i1");
		// Fallback not touched.
		expect(fallback.has).not.toHaveBeenCalled();
		expect(fallback.stats).not.toHaveBeenCalled();
		expect(fallback.search).not.toHaveBeenCalled();
		expect(fallback.getMetadata).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// 4. Sync methods route to fallback when degraded
	// -----------------------------------------------------------------------
	it("sync methods route to fallback when primary is open (degraded)", () => {
		// Pre-seed the breaker into "open" with openedAt recent (within
		// the halfOpenAfterMs window) so canAttempt() returns false.
		const primary = makeStubPrimary("p", { breakerOverride: { state: "open", openedAt: Date.now() - 100 } });
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback);
		expect(ds.health().degraded).toBe(true);
		ds.has("i1");
		ds.stats();
		ds.search("q", { limit: 5 });
		ds.getMetadata("i1");
		// Primary not called.
		expect(primary.has).not.toHaveBeenCalled();
		expect(primary.stats).not.toHaveBeenCalled();
		expect(primary.search).not.toHaveBeenCalled();
		expect(primary.getMetadata).not.toHaveBeenCalled();
		// Fallback called.
		expect(fallback.has).toHaveBeenCalledWith("i1");
		expect(fallback.stats).toHaveBeenCalled();
		expect(fallback.search).toHaveBeenCalledWith("q", { limit: 5 });
		expect(fallback.getMetadata).toHaveBeenCalledWith("i1");
	});

	// -----------------------------------------------------------------------
	// 5. Async put: primary success → no fallback call, recordSuccess
	// -----------------------------------------------------------------------
	it("async put: primary success → fallback NOT called, primary.recordSuccess() invoked", async () => {
		const logger = { log: vi.fn() };
		const primary = makeStubPrimary("p");
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback, { logger });
		const result = await ds.put("i1", "code", "<svg/>", 4, "t");
		expect(result.id).toBe("i1");
		expect(primary.put).toHaveBeenCalledWith("i1", "code", "<svg/>", 4, "t");
		expect(fallback.put).not.toHaveBeenCalled();
		expect(primary.recordSuccess).toHaveBeenCalled();
		// No breaker event on a plain success.
		const breakerOpen = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_open");
		const breakerClose = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_close");
		expect(breakerOpen).toHaveLength(0);
		expect(breakerClose).toHaveLength(0);
	});

	// -----------------------------------------------------------------------
	// 6. Async put: primary fail → fallback called + recordFailure (1 fail)
	// -----------------------------------------------------------------------
	it("async put: primary fail → fallback called + recordFailure(1); NOT yet open", async () => {
		const logger = { log: vi.fn() };
		const primary = makeStubPrimary("p");
		primary._controls.failOpForever("put", new Error("S3 timeout"));
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback, { logger });
		const result = await ds.put("i1", "code", "<svg/>", 4, "t");
		// Fallback was called with the same args.
		expect(fallback.put).toHaveBeenCalledWith("i1", "code", "<svg/>", 4, "t");
		// Result is the fallback's return value.
		expect(result.id).toBe("i1");
		// 1 failure recorded, breaker still closed.
		expect(primary.recordFailure).toHaveBeenCalledTimes(1);
		expect(primary.breaker.failureCount).toBe(1);
		expect(primary.breaker.state).toBe("closed");
		// No breaker_open event yet (transition hasn't happened).
		const breakerOpen = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_open");
		expect(breakerOpen).toHaveLength(0);
		// No counter bump on a single failure (counter only bumps on the
		// actual transition closed → open).
	});

	// -----------------------------------------------------------------------
	// 7. 3 consecutive failures trip the breaker (state=open)
	// -----------------------------------------------------------------------
	it("3 consecutive failures trip the breaker: state open, failureCount=3, openedAt set", async () => {
		const primary = makeStubPrimary("p", { breakerOverride: { threshold: 3 } });
		primary._controls.failOpForever("put", new Error("S3 down"));
		const ds = new DegradableStorage(primary, makeStubFallback("f"));
		const tBefore = Date.now();
		await ds.put("i1", "c", "s", 1);
		await ds.put("i2", "c", "s", 1);
		const tMid = Date.now();
		await ds.put("i3", "c", "s", 1);
		const tAfter = Date.now();
		expect(primary.breaker.failureCount).toBe(3);
		expect(primary.breaker.state).toBe("open");
		expect(primary.breaker.openedAt).toBeGreaterThanOrEqual(tBefore);
		expect(primary.breaker.openedAt).toBeLessThanOrEqual(tAfter);
		// recordFailure was called 3 times.
		expect(primary.recordFailure).toHaveBeenCalledTimes(3);
	});

	// -----------------------------------------------------------------------
	// 8. On trip: emit breaker_open + bump breaker_trips_count
	// -----------------------------------------------------------------------
	it("on breaker trip: emit `breaker_open` (level=warn) + bump `breaker_trips_count`", async () => {
		const tmpDir = await (await import("node:fs/promises")).mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "ds-counter-"));
		try {
			const counters = new Counters(tmpDir);
			await counters.load();
			const logger = { log: vi.fn() };
			const primary = makeStubPrimary("p", { breakerOverride: { threshold: 3 } });
			primary._controls.failOpForever("put", new Error("S3 down"));
			const ds = new DegradableStorage(primary, makeStubFallback("f"), { counters, logger });
			await ds.put("i1", "c", "s", 1);
			await ds.put("i2", "c", "s", 1);
			await ds.put("i3", "c", "s", 1); // trip
			await ds.put("i4", "c", "s", 1); // post-trip, no new open event

			// Exactly ONE breaker_open event (the actual transition).
			const breakerOpen = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_open");
			expect(breakerOpen).toHaveLength(1);
			const ev = breakerOpen[0][0];
			expect(ev.level).toBe("warn");
			expect(ev.op).toBe("put");
			expect(ev.error).toBe("S3 down");
			expect(ev.consecutive).toBe(3);
			expect(ev.threshold).toBe(3);
			expect(ev.fallback).toBe("local");
			// Counter bumped exactly once.
			expect(counters.snapshot().breaker_trips_count).toBe(1);
		} finally {
			await (await import("node:fs/promises")).rm(tmpDir, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// 9. After trip, subsequent calls skip primary (go straight to fallback)
	// -----------------------------------------------------------------------
	it("after trip, subsequent async calls skip primary (go straight to fallback) without further recordFailure", async () => {
		// threshold: 2 (so 2 failures trip the breaker), halfOpenAfterMs:
		// 1_000_000 (so the post-trip cool-down keeps subsequent calls
		// out of the half-open window — the wrapper must skip primary
		// outright during the cool-down).
		const primary = makeStubPrimary("p", { breakerOverride: { threshold: 2, halfOpenAfterMs: 1_000_000 } });
		// Pre-trip the breaker: 2 failures → open + openedAt recent.
		primary._controls.failOpForever("put", new Error("S3 down"));
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback, { threshold: 2, halfOpenAfterMs: 1_000_000 });
		await ds.put("i1", "c", "s", 1);
		await ds.put("i2", "c", "s", 1);
		// After 2nd call: state=open, openedAt set to ~now. canAttempt is
		// false for the next 1_000_000ms.
		expect(primary.breaker.state).toBe("open");
		const recordFailureCallsBefore = primary.recordFailure.mock.calls.length;
		const primaryPutCallsBefore = primary.put.mock.calls.length;
		// Subsequent 3 calls should all go to fallback; primary.put not
		// called again; recordFailure not called again (cool-down period).
		await ds.put("i3", "c", "s", 1);
		await ds.put("i4", "c", "s", 1);
		await ds.put("i5", "c", "s", 1);
		expect(primary.put.mock.calls.length).toBe(primaryPutCallsBefore);
		expect(primary.recordFailure.mock.calls.length).toBe(recordFailureCallsBefore);
		expect(fallback.put).toHaveBeenCalledTimes(3 + 2); // 3 post-trip + 2 during trip
	});

	// -----------------------------------------------------------------------
	// 10. Half-open probe: past window → primary is called
	// -----------------------------------------------------------------------
	it("half-open probe: past halfOpenAfterMs window, primary is called (probe)", async () => {
		// Pre-trip the breaker with openedAt = 5s ago and halfOpenAfterMs
		// = 1s, so canAttempt() is true (past the window). The
		// DegradableStorage opts also pin halfOpenAfterMs=1000 to ensure
		// the wrapper's default (60_000) doesn't override the test setup.
		const openedAt = Date.now() - 5000;
		const primary = makeStubPrimary("p", {
			breakerOverride: { state: "open", openedAt, threshold: 3, halfOpenAfterMs: 1000, failureCount: 3, lastFailure: { message: "prior", at: openedAt } },
		});
		// Primary will now succeed.
		const fallback = makeStubFallback("f");
		const ds = new DegradableStorage(primary, fallback, { halfOpenAfterMs: 1000 });
		expect(ds.health().degraded).toBe(false); // half-open → not degraded
		expect(primary.canAttempt()).toBe(true); // past window
		await ds.put("i9", "c", "s", 1, "t");
		// Probe was attempted.
		expect(primary.put).toHaveBeenCalledWith("i9", "c", "s", 1, "t");
		expect(fallback.put).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// 11. Probe success: recordSuccess + emit breaker_close (level=info)
	// -----------------------------------------------------------------------
	it("probe success: recordSuccess() + emit `breaker_close` (level=info); breaker_state becomes closed", async () => {
		const openedAt = Date.now() - 5000;
		const primary = makeStubPrimary("p", {
			breakerOverride: { state: "open", openedAt, threshold: 3, halfOpenAfterMs: 1000, failureCount: 3, lastFailure: { message: "prior", at: openedAt } },
		});
		const logger = { log: vi.fn() };
		const ds = new DegradableStorage(primary, makeStubFallback("f"), { logger, halfOpenAfterMs: 1000 });
		await ds.put("i10", "c", "s", 1);
		// recordSuccess was called.
		expect(primary.recordSuccess).toHaveBeenCalled();
		// Breaker now closed.
		expect(primary.breaker.state).toBe("closed");
		expect(primary.breaker.failureCount).toBe(0);
		expect(primary.breaker.openedAt).toBeNull();
		// Exactly one breaker_close event at level=info.
		const breakerClose = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_close");
		expect(breakerClose).toHaveLength(1);
		const ev = breakerClose[0][0];
		expect(ev.level).toBe("info");
		expect(ev.op).toBe("put");
		// recovered_after_ms is roughly 5000 (window since openedAt).
		expect(typeof ev.recovered_after_ms).toBe("number");
		expect(ev.recovered_after_ms).toBeGreaterThan(4000);
		// health() reflects the new state.
		expect(ds.health().degraded).toBe(false);
		expect(ds.health().breaker_state).toBe("closed");
	});

	// -----------------------------------------------------------------------
	// 12. Probe failure: cool-down extended, no second breaker_open event
	// -----------------------------------------------------------------------
	it("probe failure: recordFailure re-stamps openedAt; NO second breaker_open event (avoid log storm)", async () => {
		const openedAt = Date.now() - 5000;
		const primary = makeStubPrimary("p", {
			breakerOverride: { state: "open", openedAt, threshold: 3, halfOpenAfterMs: 1000, failureCount: 3, lastFailure: { message: "prior", at: openedAt } },
		});
		// Probe will fail.
		primary._controls.failOpForever("put", new Error("S3 still down"));
		const logger = { log: vi.fn() };
		const ds = new DegradableStorage(primary, makeStubFallback("f"), { logger, halfOpenAfterMs: 1000 });
		const before = Date.now();
		await ds.put("i11", "c", "s", 1);
		const after = Date.now();
		// recordFailure called → failureCount bumped from 3 → 4, but
		// recordFailure returns opened=false (breaker was already open).
		expect(primary.recordFailure).toHaveBeenCalledTimes(1);
		expect(primary.breaker.failureCount).toBe(4);
		expect(primary.breaker.state).toBe("open");
		// openedAt was re-stamped to ~now (cool-down extended).
		expect(primary.breaker.openedAt).toBeGreaterThanOrEqual(before);
		expect(primary.breaker.openedAt).toBeLessThanOrEqual(after);
		// NO breaker_open event this time (only one for the actual
		// transition, way back in the constructor's threshold setting).
		const breakerOpen = logger.log.mock.calls.filter((c) => c[0]?.event === "breaker_open");
		expect(breakerOpen).toHaveLength(0);
		// put went to fallback (we didn't keep a reference to fallback
		// in this scope, but we know the wrapper never threw, so the
		// call resolved and the success path is unreachable on a probe
		// failure).
		expect(primary.recordSuccess).not.toHaveBeenCalled();
	});
});
