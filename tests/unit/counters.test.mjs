// tests/unit/counters.test.mjs — unit tests for src/counters.mjs.
//
// R010 contract: 6 counter keys persisted to <root>/counters.json via
// tmp+rename atomic write, single-flight in-process mutex, corruption-
// tolerant load. These tests pin the contract on a real temp directory
// (mkdtemp per S01 pattern, rm in afterEach) — no mocking of the
// filesystem so we exercise the actual write/rename/unlink code paths.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Counters, COUNTER_KEYS } from "../../src/counters.mjs";

describe("Counters (R010)", () => {
	/** @type {string} */
	let root;
	/** @type {Counters} */
	let counters;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "counters-test-"));
		counters = new Counters(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("fresh root → snapshot has all 6 keys at 0", async () => {
		await counters.load();
		const snap = counters.snapshot();
		for (const k of COUNTER_KEYS) {
			expect(snap).toHaveProperty(k, 0);
		}
		// And only the 6 documented keys (no extras from a stale prior run).
		expect(Object.keys(snap).sort()).toEqual([...COUNTER_KEYS].sort());
	});

	it("increment('render_total') bumps the value to 1 and persists to disk", async () => {
		await counters.load();
		const newVal = await counters.increment("render_total");
		expect(newVal).toBe(1);
		expect(counters.snapshot().render_total).toBe(1);

		// Persistence: the JSON file on disk reflects the new value.
		const raw = await readFile(join(root, "counters.json"), "utf-8");
		const obj = JSON.parse(raw);
		expect(obj.render_total).toBe(1);
		// Other keys stay at 0.
		for (const k of COUNTER_KEYS) {
			if (k !== "render_total") expect(obj[k]).toBe(0);
		}
	});

	it("Promise.all of 100 concurrent increments yields final value 100 (single-flight mutex)", async () => {
		await counters.load();
		const promises = [];
		for (let i = 0; i < 100; i++) promises.push(counters.increment("render_total"));
		const results = await Promise.all(promises);
		// All 100 calls return — the last is 100.
		expect(results[results.length - 1]).toBe(100);
		expect(counters.snapshot().render_total).toBe(100);

		// Persistence check: the on-disk file agrees.
		const raw = await readFile(join(root, "counters.json"), "utf-8");
		const obj = JSON.parse(raw);
		expect(obj.render_total).toBe(100);
	});

	it("corrupted JSON on disk → load() starts fresh with all keys at 0", async () => {
		// Pre-seed the file with non-JSON garbage, then a Counters on this
		// root must recover cleanly (corruption tolerance, R010).
		await writeFile(join(root, "counters.json"), "{this is not json", "utf-8");
		await counters.load();
		const snap = counters.snapshot();
		for (const k of COUNTER_KEYS) {
			expect(snap[k]).toBe(0);
		}
	});

	it("missing counters.json → load() starts fresh with all keys at 0", async () => {
		// No file pre-seeded — load() must not throw.
		await expect(counters.load()).resolves.toBeDefined();
		const snap = counters.snapshot();
		for (const k of COUNTER_KEYS) {
			expect(snap[k]).toBe(0);
		}
	});

	it("counters.json.tmp is unlinked after a successful increment (atomic write)", async () => {
		await counters.load();
		await counters.increment("render_total");
		expect(existsSync(join(root, "counters.json"))).toBe(true);
		expect(existsSync(join(root, "counters.json.tmp"))).toBe(false);
	});

	it("a second Counters instance on the same root loads the persisted values", async () => {
		// First instance: increment a few counters and persist.
		await counters.load();
		await counters.increment("render_total");
		await counters.increment("render_total");
		await counters.increment("ascii_failures");
		await counters.increment("sweep_runs");
		await counters.increment("sweep_runs");
		await counters.increment("sweep_runs");
		await counters.increment("sweep_runs");
		await counters.increment("sweep_runs");

		// Second instance on the same root — must see the persisted values.
		const c2 = new Counters(root);
		await c2.load();
		const snap = c2.snapshot();
		expect(snap.render_total).toBe(2);
		expect(snap.ascii_failures).toBe(1);
		expect(snap.sweep_runs).toBe(5);
	});

	it("snapshot() returns a shallow copy — mutating the snapshot does not affect internal state", async () => {
		await counters.load();
		await counters.increment("render_total"); // → 1
		const snap1 = counters.snapshot();
		snap1.render_total = 999;
		snap1.new_garbage_key = 42;
		// Internal state untouched.
		const snap2 = counters.snapshot();
		expect(snap2.render_total).toBe(1);
		expect(snap2).not.toHaveProperty("new_garbage_key");
	});

	it("unknown counter keys are accepted and persisted (forward-compat)", async () => {
		await counters.load();
		await counters.increment("future_counter");
		expect(counters.snapshot().future_counter).toBe(1);
		// Persistence check: a new instance sees it.
		const c2 = new Counters(root);
		await c2.load();
		expect(c2.snapshot().future_counter).toBe(1);
	});

	it("a stale counters.json.tmp from a prior crash is cleaned up on load()", async () => {
		// Pre-seed a stale .tmp (simulating a crash mid-rename).
		await writeFile(join(root, "counters.json.tmp"), "stale", "utf-8");
		await counters.load();
		// After load(), the .tmp is unlinked so a follow-up increment does
		// not see a confused state.
		expect(existsSync(join(root, "counters.json.tmp"))).toBe(false);
	});
});
