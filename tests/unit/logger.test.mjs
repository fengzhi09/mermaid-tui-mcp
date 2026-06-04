// tests/unit/logger.test.mjs — unit tests for src/logger.mjs.
//
// R008 contract: every log call writes exactly one JSON line to stderr
// with stable field order {ts, level, event, code?, id?, ...rest}.
// These tests pin that contract so future refactors don't break log
// consumers (the gsd-pi extension, the /health metrics surface, and
// human operators grep'ing for {ts,level,event}).
//
// Per S01 follow-up "S03 must not pollute unit-test silence", every
// test mocks process.stderr.write and restores it in afterEach — no
// real stderr is touched and vitest's --reporter=verbose stays clean.

import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "../../src/logger.mjs";

/**
 * Read all bytes written to the mock stderr by the test, and return the
 * first line (the call site under test only ever writes one line).
 * @param {ReturnType<typeof vi.spyOn>} spy
 */
function readLine(spy) {
	const calls = spy.mock.calls;
	if (calls.length === 0) return null;
	const arg = calls[0][0];
	return typeof arg === "string" ? arg : Buffer.is(arg) ? arg.toString("utf-8") : String(arg);
}

describe("logger (R008)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes exactly once per call and the line ends with a newline", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "x" });
		expect(spy).toHaveBeenCalledTimes(1);
		const line = readLine(spy);
		expect(line).toMatch(/\n$/);
		// No embedded newlines anywhere else in the JSON payload.
		const body = line.replace(/\n$/, "");
		expect(body).not.toMatch(/\n/);
	});

	it("the line parses as a single JSON object containing the required fields", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "boot", version: "0.1.0" });
		const body = readLine(spy).replace(/\n$/, "");
		const obj = JSON.parse(body);
		expect(obj).toHaveProperty("ts");
		expect(obj).toHaveProperty("level", "info");
		expect(obj).toHaveProperty("event", "boot");
		expect(obj).toHaveProperty("version", "0.1.0");
	});

	it("ts is an ISO 8601 string parseable by new Date()", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "ts_check" });
		const obj = JSON.parse(readLine(spy).replace(/\n$/, ""));
		expect(typeof obj.ts).toBe("string");
		// ISO 8601 with milliseconds and Z (or +00:00) timezone designator.
		expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(Z|\+\d{2}:\d{2})$/);
		const d = new Date(obj.ts);
		expect(Number.isFinite(d.getTime())).toBe(true);
		// Round-trip stable: parsed back to ISO gives the same value.
		expect(d.toISOString()).toBe(obj.ts);
	});

	it("level defaults to 'info' when not provided", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "default_level" });
		const obj = JSON.parse(readLine(spy).replace(/\n$/, ""));
		expect(obj.level).toBe("info");
	});

	it("omits code and id when null or undefined (does NOT emit 'code': null)", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "no_code", code: null, id: undefined });
		const body = readLine(spy).replace(/\n$/, "");
		// substring check on the raw line, not the parsed object, so we
		// catch both omitted and 'code": null' as distinct byte sequences.
		expect(body).not.toMatch(/"code"/);
		expect(body).not.toMatch(/"id"/);
		const obj = JSON.parse(body);
		expect(obj).not.toHaveProperty("code");
		expect(obj).not.toHaveProperty("id");
	});

	it("emits code and id when provided, and preserves extra fields in stable order", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "with_extras", code: -32004, id: "mTest1", retryable: true, host: "127.0.0.1", port: 5300 });
		const body = readLine(spy).replace(/\n$/, "");
		const obj = JSON.parse(body);
		expect(obj).toEqual({
			ts: obj.ts, // dynamic; just check the rest
			level: "info",
			event: "with_extras",
			code: -32004,
			id: "mTest1",
			retryable: true,
			host: "127.0.0.1",
			port: 5300,
		});
		// Stable field order: ts, level, event, code, id, then the rest in
		// insertion order (retryable, host, port).
		const keys = Object.keys(obj);
		expect(keys[0]).toBe("ts");
		expect(keys[1]).toBe("level");
		expect(keys[2]).toBe("event");
		expect(keys[3]).toBe("code");
		expect(keys[4]).toBe("id");
		expect(keys.slice(5)).toEqual(["retryable", "host", "port"]);
	});

	it("keeps the line a single line even when extras contain newlines", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		log({ event: "multiline", note: "line1\nline2\nline3" });
		const line = readLine(spy);
		// Exactly one trailing \n — no embedded newlines survive in the
		// raw bytes (JSON.stringify escapes \n as \\n).
		const matches = line.match(/\n/g) || [];
		expect(matches.length).toBe(1);
		// And the parsed value round-trips with the original newline preserved.
		const obj = JSON.parse(line.replace(/\n$/, ""));
		expect(obj.note).toBe("line1\nline2\nline3");
	});

	it("swallows process.stderr.write failures (EPIPE-style) without throwing", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {
			const e = new Error("EPIPE");
			e.code = "EPIPE";
			throw e;
		});
		// Must not throw — best-effort logging must not crash the renderer.
		expect(() => log({ event: "epipe_test" })).not.toThrow();
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
