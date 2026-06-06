// tests/unit/health-state.test.mjs — unit tests for src/health-state.mjs.
//
// R009 contract: /health returns { ..., last_render_ms, last_errors: [...] }.
// last_render_ms is a number (0 when no tool has been called yet).
// last_errors is a 5-element FIFO ring buffer; it is ALWAYS an array
// (never undefined), and pushes past 5 drop the oldest entry.
//
// T04 contract additions:
//   - last_oss_failure: { ts, code, msg } | null — the most recent OSS
//     failure's tagged shape (boot-degraded path or runtime breaker).
//   - boot_degraded: boolean — true iff the boot path fell back to
//     LocalFsStorage due to an OssEnvInvalidError.

import { afterEach, describe, expect, it } from "vitest";

import {
	__resetHealthStateForTesting,
	getBootOssFailure,
	getLastRenderMs,
	isBootDegraded,
	recordError,
	setBootDegraded,
	setBootOssFailure,
	setLastRenderMs,
	snapshot,
} from "../../src/health-state.mjs";

describe("health-state (R009 /health surface)", () => {
	afterEach(() => {
		// Module-level state would leak between tests otherwise; the
		// reset seam restores the documented "fresh" baseline.
		__resetHealthStateForTesting();
	});

	it("a) snapshot() defaults: last_render_ms === 0, last_errors === [], last_oss_failure === null, boot_degraded === false", () => {
		const snap = snapshot();
		expect(snap.last_render_ms).toBe(0);
		expect(Array.isArray(snap.last_errors)).toBe(true);
		expect(snap.last_errors).toEqual([]);
		// T04 defaults: the two new fields are present and at their
		// "no failure observed yet" / "clean boot" baselines.
		expect(snap.last_oss_failure).toBeNull();
		expect(snap.boot_degraded).toBe(false);
		// all four fields are always present (never undefined) so /health can
		// spread the snapshot without optional-chaining
		expect(snap).toHaveProperty("last_render_ms");
		expect(snap).toHaveProperty("last_errors");
		expect(snap).toHaveProperty("last_oss_failure");
		expect(snap).toHaveProperty("boot_degraded");
	});

	it("b) recordError pushes to the ring; snapshot reflects it", () => {
		recordError({ code: -32001, retryable: true, message: "render timed out" });
		const snap = snapshot();
		expect(snap.last_errors).toHaveLength(1);
		expect(snap.last_errors[0].code).toBe(-32001);
		expect(snap.last_errors[0].retryable).toBe(true);
		expect(snap.last_errors[0].message).toBe("render timed out");
		// the `at` field is a wall-clock epoch ms (within a sane window)
		expect(typeof snap.last_errors[0].at).toBe("number");
		const now = Date.now();
		expect(snap.last_errors[0].at).toBeGreaterThan(now - 5_000);
		expect(snap.last_errors[0].at).toBeLessThanOrEqual(now);
	});

	it("c) ring is bounded at 5: record 7, keep the most recent 5, drop the oldest 2", () => {
		for (let i = 1; i <= 7; i++) {
			recordError({ code: -32000 - i, retryable: false, message: `error ${i}` });
		}
		const snap = snapshot();
		expect(snap.last_errors).toHaveLength(5);
		// the oldest 2 (errors 1 and 2) are gone
		expect(snap.last_errors.some((e) => e.message === "error 1")).toBe(false);
		expect(snap.last_errors.some((e) => e.message === "error 2")).toBe(false);
		// the most recent (error 7) is at the end
		expect(snap.last_errors[4].message).toBe("error 7");
		expect(snap.last_errors[4].code).toBe(-32007);
		// and the kept window is errors 3..7 in insertion order
		const codes = snap.last_errors.map((e) => e.code);
		expect(codes).toEqual([-32003, -32004, -32005, -32006, -32007]);
	});

	it("d) setLastRenderMs / getLastRenderMs round-trip", () => {
		expect(getLastRenderMs()).toBe(0); // baseline
		setLastRenderMs(123);
		expect(getLastRenderMs()).toBe(123);
		setLastRenderMs(456);
		expect(getLastRenderMs()).toBe(456);
		// non-numeric inputs degrade to 0 (defensive)
		setLastRenderMs("not a number");
		expect(getLastRenderMs()).toBe(0);
		setLastRenderMs(Number.NaN);
		expect(getLastRenderMs()).toBe(0);
		// and the snapshot exposes the latest value
		setLastRenderMs(789);
		expect(snapshot().last_render_ms).toBe(789);
	});

	// ==========================================================================
	// T04 /health extension: boot_degraded + last_oss_failure
	// ==========================================================================

	it("e) setBootDegraded / isBootDegraded: default false, set true flips, set false reverts", () => {
		expect(isBootDegraded()).toBe(false);
		setBootDegraded(true);
		expect(isBootDegraded()).toBe(true);
		// snapshot reflects the change
		expect(snapshot().boot_degraded).toBe(true);
		// reverting (test seam only — production never sets false)
		setBootDegraded(false);
		expect(isBootDegraded()).toBe(false);
		expect(snapshot().boot_degraded).toBe(false);
		// truthy coercion: any non-falsy value is true
		setBootDegraded(1);
		expect(isBootDegraded()).toBe(true);
		setBootDegraded("yes");
		expect(isBootDegraded()).toBe(true);
	});

	it("f) setBootOssFailure / getBootOssFailure: record carries the canonical {ts, code, msg} shape", () => {
		// Baseline: no failure recorded.
		expect(getBootOssFailure()).toBeNull();
		expect(snapshot().last_oss_failure).toBeNull();
		// Set with a numeric code (the typical boot-degraded path: -32006).
		const before = Date.now();
		setBootOssFailure({ ts: 1700000000000, code: -32006, msg: "OssStorage env invalid; missing required vars: MERMAID_OSS_BUCKET" });
		const after = Date.now();
		const f = getBootOssFailure();
		expect(f).not.toBeNull();
		expect(f.ts).toBe(1700000000000);
		expect(f.code).toBe(-32006);
		expect(f.msg).toMatch(/OssStorage env invalid/);
		// snapshot exposes a deep copy (mutating the returned object must
		// not affect internal state).
		const s = snapshot().last_oss_failure;
		expect(s).toEqual({ ts: 1700000000000, code: -32006, msg: expect.stringMatching(/OssStorage env invalid/) });
		s.msg = "mutated";
		expect(getBootOssFailure().msg).toMatch(/OssStorage env invalid/); // internal state untouched
		// Sub-second sanity for the ts default path. The auto-ts is
		// stamped inside setBootOssFailure, so capture the bounds AROUND
		// that specific call (not around the earlier one).
		const tBefore2 = Date.now();
		setBootOssFailure({ code: -32004, msg: "EAGAIN" }); // no ts
		const tAfter2 = Date.now();
		const auto = getBootOssFailure();
		expect(auto.ts).toBeGreaterThanOrEqual(tBefore2);
		expect(auto.ts).toBeLessThanOrEqual(tAfter2);
		expect(auto.code).toBe(-32004);
		expect(auto.msg).toBe("EAGAIN");
		// String codes are accepted (e.g. S3 error names like "NoSuchBucket").
		setBootOssFailure({ ts: 1, code: "NoSuchBucket", msg: "s3 missing" });
		expect(getBootOssFailure()).toEqual({ ts: 1, code: "NoSuchBucket", msg: "s3 missing" });
	});

	it("g) setBootOssFailure with a non-object / null clears the record", () => {
		setBootOssFailure({ ts: 1, code: -32006, msg: "first" });
		expect(getBootOssFailure()).not.toBeNull();
		setBootOssFailure(null);
		expect(getBootOssFailure()).toBeNull();
		expect(snapshot().last_oss_failure).toBeNull();
		setBootOssFailure({ ts: 2, code: -32004, msg: "second" });
		setBootOssFailure(undefined);
		expect(getBootOssFailure()).toBeNull();
	});

	it("h) __resetHealthStateForTesting clears boot_degraded and last_oss_failure alongside the ring", () => {
		setLastRenderMs(42);
		recordError({ code: -1, retryable: false, message: "x" });
		setBootDegraded(true);
		setBootOssFailure({ ts: 1, code: -32006, msg: "env" });
		expect(snapshot().boot_degraded).toBe(true);
		expect(snapshot().last_oss_failure).not.toBeNull();
		__resetHealthStateForTesting();
		const snap = snapshot();
		expect(snap.last_render_ms).toBe(0);
		expect(snap.last_errors).toEqual([]);
		expect(snap.boot_degraded).toBe(false);
		expect(snap.last_oss_failure).toBeNull();
	});

	it("i) snapshot deep-copies last_oss_failure (mutating the snapshot does not affect internal state)", () => {
		setBootOssFailure({ ts: 100, code: -32006, msg: "env invalid" });
		const s1 = snapshot();
		s1.last_oss_failure.msg = "MUTATED";
		s1.last_oss_failure.code = 999;
		const s2 = snapshot();
		// Internal state untouched — the second snapshot still reports the
		// original code/msg.
		expect(s2.last_oss_failure.code).toBe(-32006);
		expect(s2.last_oss_failure.msg).toBe("env invalid");
		expect(getBootOssFailure().msg).toBe("env invalid");
	});
});
