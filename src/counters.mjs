// src/counters.mjs — persistent monotonic counters in <root>/counters.json.
//
// R010 requires atomic, corruption-tolerant counter persistence so the
// /health surface can report render_total / render_errors /
// ascii_failures / storage_write_retries / sweep_runs / sweep_removed
// across restarts. The on-disk format is intentionally human-readable
// JSON (2-space indent) so a developer can `cat data/counters.json` to
// inspect runtime state without a parser.
//
// Concurrency: a single in-process promise chain (this._writeChain)
// serializes every write so two concurrent increment() callers cannot
// lose updates. This is intentionally single-process only — R037
// documents that multi-process coordination is out of scope for M001.
//
// Atomicity: the save path is write-to-tmp + rename. A crash mid-write
// leaves the .tmp behind, which the next load() unlinks before reading
// the real file. A successful rename() is atomic on POSIX and on NTFS
// (the two OS targets per package.json "engines": node>=22 runs on
// linux/darwin/win32).

import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The counter keys the /health surface reads. Unknown keys are also
 *  accepted by increment() (forward-compat) but are NOT seeded on load.
 *  M003/S03/T01 adds oss_init_degraded_count — the count of times the
 *  server boot path caught OssEnvInvalidError and fell back to local.
 *  (breaker_trips_count is added in T04 alongside /health.backend.) */
export const COUNTER_KEYS = [
	"render_total",
	"render_errors",
	"ascii_failures",
	"storage_write_retries",
	"sweep_runs",
	"sweep_removed",
	"oss_init_degraded_count",
];

/** Build a fresh-zero values map. */
function freshValues() {
	return Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
}

export class Counters {
	/**
	 * @param {string} root  the data dir (counters.json lives at <root>/counters.json)
	 */
	constructor(root) {
		this.root = root;
		this.path = join(root, "counters.json");
		this.tmpPath = join(root, "counters.json.tmp");
		this.values = freshValues();
		// Single-flight chain: every increment() appends a .then() so writes
		// run strictly one-after-another. Initialised to Promise.resolve()
		// so the first increment doesn't see a null chain.
		this._writeChain = Promise.resolve();
	}

	/**
	 * Read <root>/counters.json into this.values. Corrupted JSON or a
	 * missing file both fall back to fresh zeros. Any leftover .tmp from
	 * a previous crash is best-effort unlinked so a follow-up save does
	 * not see stale state.
	 */
	async load() {
		// Best-effort: if a previous process crashed mid-save, the .tmp is
		// stale and the real file is authoritative. Clean it up first.
		if (existsSync(this.tmpPath)) {
			try {
				await unlink(this.tmpPath);
			} catch {
				// ignore — best-effort
			}
		}
		if (!existsSync(this.path)) {
			this.values = freshValues();
			return this.values;
		}
		try {
			const raw = await readFile(this.path, "utf-8");
			const obj = JSON.parse(raw);
			if (obj && typeof obj === "object" && !Array.isArray(obj)) {
				// Seed freshValues to keep deterministic key set, then
				// overlay any persisted values (forward-compat: extra keys
				// are preserved; missing keys fall back to 0).
				const merged = freshValues();
				for (const [k, v] of Object.entries(obj)) {
					if (typeof v === "number" && Number.isFinite(v)) merged[k] = v;
				}
				this.values = merged;
			} else {
				this.values = freshValues();
			}
		} catch {
			// Corrupted JSON: start fresh rather than crash the renderer.
			this.values = freshValues();
		}
		return this.values;
	}

	/**
	 * Atomically bump `key` by 1 and persist. Keys not in COUNTER_KEYS
	 * are accepted (forward-compat) and created with default 0 on first
	 * use. Returns the new value.
	 *
	 * The .then() chain is the single-flight mutex: even N concurrent
	 * callers see all N increments reflected in the final on-disk state
	 * (verified by the 100-iteration test in tests/unit/counters.test.mjs).
	 *
	 * @param {string} key
	 * @returns {Promise<number>} the new value
	 */
	async increment(key) {
		this._writeChain = this._writeChain.then(async () => {
			this.values[key] = (this.values[key] || 0) + 1;
			const json = JSON.stringify(this.values, null, 2);
			await writeFile(this.tmpPath, json, "utf-8");
			await rename(this.tmpPath, this.path);
		});
		await this._writeChain;
		return this.values[key];
	}

	/**
	 * Return a shallow copy of the current values. Mutating the result
	 * MUST NOT affect internal state (verified by the snapshot-isolation
	 * test).
	 *
	 * @returns {Record<string, number>}
	 */
	snapshot() {
		return { ...this.values };
	}
}
