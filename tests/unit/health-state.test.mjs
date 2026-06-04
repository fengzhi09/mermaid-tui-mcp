// tests/unit/health-state.test.mjs — unit tests for src/health-state.mjs.
//
// R009 contract: /health returns { ..., last_render_ms, last_errors: [...] }.
// last_render_ms is a number (0 when no tool has been called yet).
// last_errors is a 5-element FIFO ring buffer; it is ALWAYS an array
// (never undefined), and pushes past 5 drop the oldest entry.

import { afterEach, describe, expect, it } from "vitest";

import {
	__resetHealthStateForTesting,
	getLastRenderMs,
	recordError,
	setLastRenderMs,
	snapshot,
} from "../../src/health-state.mjs";

describe("health-state (R009 /health surface)", () => {
	afterEach(() => {
		// Module-level state would leak between tests otherwise; the
		// reset seam restores the documented "fresh" baseline.
		__resetHealthStateForTesting();
	});

	it("a) snapshot() defaults: last_render_ms === 0, last_errors === []", () => {
		const snap = snapshot();
		expect(snap.last_render_ms).toBe(0);
		expect(Array.isArray(snap.last_errors)).toBe(true);
		expect(snap.last_errors).toEqual([]);
		// both fields are always present (never undefined) so /health can
		// spread the snapshot without optional-chaining
		expect(snap).toHaveProperty("last_render_ms");
		expect(snap).toHaveProperty("last_errors");
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
});
