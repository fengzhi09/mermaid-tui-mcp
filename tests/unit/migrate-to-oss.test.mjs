// tests/unit/migrate-to-oss.test.mjs — unit tests for bin/migrate-to-oss.mjs.
//
// Drives the same `runMigration` export the CLI uses, capturing the
// structured events on stderr via a vi.spyOn(process.stderr, "write")
// and the summary on stdout via process.stdout.write. The
// integration test in tests/integration/migrate-to-oss.test.mjs
// exercises the real MinIO path; this file is stub-only — no network.
//
// The stub target is Map-shaped: it implements has() (sync), put()
// (records the call), save() (no-op for the stub), stats(), and
// getMetadata(). The stub does not implement readSvg() because the
// source side is the LocalFsStorage — the migration reads the
// blob from the source (real disk) and writes the entry to the
// target stub. This is the same split the S01 integration tests
// use (real source on disk, stub S3 client on the wire).
//
// Test scenarios (10 it() blocks, all stub-backend, no network):
//   1. fixture produces 5 entries pre-sweep, 4 post-sweep
//   2. dry-run does NOT call target.put
//   3. dry-run emits migrate_dry_run events for every surviving entry
//   4. real mode calls target.put for every surviving entry
//   5. target.has(id) === true skips that entry (idempotency)
//   6. target.has(id) === true emits migrate_skip event
//   7. second-run is a no-op when target already has every id
//   8. --source-dir overrides MERMAID_RENDERER_DATA
//   9. --help exits 0 with usage
//  10. missing required env vars exits 1 with human message

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeLocalFixture, MIGRATE_FIXTURE_SEED } from "../helpers/migrate-fixture.mjs";
import { runMigration, formatSummary } from "../../bin/migrate-to-oss.mjs";
import { OssEnvInvalidError } from "../../src/storage/OssStorage.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname_test = dirname(__filename);
const REPO_ROOT_FROM_TEST = resolve(__dirname_test, "..", "..");

// ---------------------------------------------------------------------------
// Stub target — Map-shaped, with the methods the migration CLI calls:
//   has(id)           — sync in-memory lookup
//   put(...)          — record the call, return a new entry
//   save()            — no-op (the stub is in-memory)
//   stats()           — { total, pinned, unpinned }
//   getMetadata(id)   — return the entry or null
// ---------------------------------------------------------------------------

function makeStubTarget() {
	const store = new Map();
	const puts = [];
	const saves = 0;
	return {
		store,
		puts,
		get saves() { return saves; },
		has(id) { return store.has(id); },
		async put(id, code, svg, ascii, sourceLength, title) {
			const entry = {
				code,
				createdAt: Date.now(),
				pinned: false,
				lastAccessedAt: Date.now(),
				sourceLength: typeof sourceLength === "number" ? sourceLength : code.length,
				title: typeof title === "string" ? title : "",
				ascii: typeof ascii === "string" ? ascii : "",
			};
			store.set(id, entry);
			puts.push({ id, code, svg, ascii, sourceLength, title });
			return entry;
		},
		async save() { /* no-op for the stub */ },
		stats() {
			let pinned = 0;
			for (const e of store.values()) if (e.pinned) pinned++;
			return { total: store.size, pinned, unpinned: store.size - pinned };
		},
		getMetadata(id) {
			return store.get(id) || null;
		},
	};
}

// ---------------------------------------------------------------------------
// stderr capture helper — vi.spyOn(process.stderr, "write") buffers
// each write call's first argument as a string. We expose
// getEvents(buffer) which parses each line as JSON and returns the
// list of event names. Mirrors the pattern from
// tests/unit/server-helpers.test.mjs "log" test.
// ---------------------------------------------------------------------------

function installStderrSpy() {
	const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
	const buffer = [];
	spy.mock.calls.forEach(([chunk]) => {
		const text = typeof chunk === "string" ? chunk : Buffer.is(chunk) ? chunk.toString("utf-8") : String(chunk || "");
		buffer.push(text);
	});
	const flush = () => {
		buffer.length = 0;
		for (const call of spy.mock.calls) {
			const chunk = call[0];
			const text = typeof chunk === "string" ? chunk : Buffer.is(chunk) ? chunk.toString("utf-8") : String(chunk || "");
			buffer.push(text);
		}
	};
	const getLines = () => buffer
		.join("")
		.split("\n")
		.filter((l) => l.length > 0);
	const getEvents = () => {
		const events = [];
		for (const line of getLines()) {
			try {
				const obj = JSON.parse(line);
				if (obj && typeof obj.event === "string") events.push(obj);
			} catch {
				// not a JSON log line (e.g. the human-readable "missing required vars" line) — skip
			}
		}
		return events;
	};
	const restore = () => spy.mockRestore();
	return { spy, flush, getLines, getEvents, restore };
}

// ---------------------------------------------------------------------------
// stdout capture helper — same pattern as stderr but for stdout.
// ---------------------------------------------------------------------------

function installStdoutSpy() {
	const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => {});
	const getText = () => spy.mock.calls
		.map(([chunk]) => typeof chunk === "string" ? chunk : Buffer.is(chunk) ? chunk.toString("utf-8") : String(chunk || ""))
		.join("");
	const restore = () => spy.mockRestore();
	return { spy, getText, restore };
}

describe("migrate-to-oss (S02 T02)", () => {
	/** @type {string|null} */
	let tmpRoot = null;
	let stderrSpy;
	let stdoutSpy;

	beforeEach(async () => {
		tmpRoot = await mkdtemp(join(tmpdir(), "migrate-test-"));
	});

	afterEach(async () => {
		if (tmpRoot) {
			await rm(tmpRoot, { recursive: true, force: true });
			tmpRoot = null;
		}
		if (stderrSpy) {
			stderrSpy.restore();
			stderrSpy = null;
		}
		if (stdoutSpy) {
			stdoutSpy.restore();
			stdoutSpy = null;
		}
		vi.restoreAllMocks();
	});

	// -----------------------------------------------------------------------
	// Test 1 — fixture produces 5 entries pre-sweep, 4 post-sweep
	// -----------------------------------------------------------------------
	it("migrate-to-oss fixture produces 5 entries pre-sweep, 4 post-sweep", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		// Pre-sweep: SEED has 5 entries.
		expect(fixture.ids).toHaveLength(5);
		expect(fixture.ids).toEqual(MIGRATE_FIXTURE_SEED.map((e) => e.id));
		// Post-sweep: the 4 surviving ids (everything except the
		// expired-unpinned entry).
		expect(fixture.survivingIds).toHaveLength(4);
		expect(fixture.survivingIds).not.toContain("expired-unpinned");
		// And the in-memory store matches the post-sweep shape.
		expect(fixture.storage.store.size).toBe(4);
		for (const id of fixture.survivingIds) {
			expect(fixture.storage.has(id)).toBe(true);
		}
		expect(fixture.storage.has("expired-unpinned")).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Test 2 — dry-run does NOT call target.put
	// -----------------------------------------------------------------------
	it("migrate-to-oss with dry-run flag does NOT call target.put", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();
		stderrSpy = installStderrSpy();

		const result = await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: true,
		});

		expect(target.puts).toHaveLength(0);
		expect(target.store.size).toBe(0);
		expect(result.copied).toBe(4); // dry-run counts would-copy in `copied`
		expect(result.skipped).toBe(0);
		expect(result.dryRun).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Test 3 — dry-run emits migrate_dry_run events for every surviving entry
	// -----------------------------------------------------------------------
	it("migrate-to-oss with dry-run emits migrate_dry_run events for every surviving entry", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();
		stderrSpy = installStderrSpy();

		await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: true,
		});

		stderrSpy.flush();
		const events = stderrSpy.getEvents();
		const dryRunEvents = events.filter((e) => e.event === "migrate_dry_run");
		expect(dryRunEvents).toHaveLength(4);
		const dryRunIds = dryRunEvents.map((e) => e.id).sort();
		expect(dryRunIds).toEqual([...fixture.survivingIds].sort());
		// Each dry-run event has the documented field shape.
		for (const e of dryRunEvents) {
			expect(e.level).toBe("info");
			expect(typeof e.title).toBe("string");
			expect(typeof e.pinned).toBe("boolean");
			expect(typeof e.bytes).toBe("number");
		}
	});

	// -----------------------------------------------------------------------
	// Test 4 — real mode calls target.put for every surviving entry
	// -----------------------------------------------------------------------
	it("migrate-to-oss real mode calls target.put for every surviving entry", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();
		stderrSpy = installStderrSpy();

		const result = await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: false,
		});

		expect(target.puts).toHaveLength(4);
		expect(result.copied).toBe(4);
		expect(result.skipped).toBe(0);
		// Byte-equal content for each surviving entry — match the
		// source's code, svg, sourceLength, title.
		for (const put of target.puts) {
			const seed = MIGRATE_FIXTURE_SEED.find((e) => e.id === put.id);
			expect(seed).toBeTruthy();
			expect(put.code).toBe(seed.code);
			expect(put.svg).toBe(seed.svg);
			expect(put.sourceLength).toBe(seed.sourceLength);
			expect(put.title).toBe(seed.title);
		}
		// The target's store has the 4 surviving entries with the
		// source's age preserved (createdAt re-stamped, not
		// Date.now() at put-time).
		const sourceCreatedAt = (id) => fixture.storage.store.get(id).createdAt;
		for (const id of fixture.survivingIds) {
			const targetEntry = target.store.get(id);
			expect(targetEntry).toBeTruthy();
			expect(targetEntry.code).toBe(fixture.storage.store.get(id).code);
			expect(targetEntry.title).toBe(fixture.storage.store.get(id).title);
			expect(targetEntry.pinned).toBe(fixture.storage.store.get(id).pinned);
			// createdAt is the source's age, not Date.now() at put-time.
			// The re-stamp happens inside the migration so the target's
			// 7-day TTL is identical to the source's 7-day TTL.
			expect(targetEntry.createdAt).toBe(sourceCreatedAt(id));
		}
		// migrate_done event is emitted at the end.
		stderrSpy.flush();
		const events = stderrSpy.getEvents();
		const doneEvents = events.filter((e) => e.event === "migrate_done");
		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0].copied).toBe(4);
		expect(doneEvents[0].skipped).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Test 5 — target.has(id) === true skips that entry
	// -----------------------------------------------------------------------
	it("migrate-to-oss with target.has(id) === true skips that entry", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();
		// Pre-populate the target with `fresh-pinned-0` having a
		// different title — the migration must NOT overwrite it.
		// We do this with a direct store.set so the stub's `puts`
		// counter stays at 0 BEFORE the migration runs.
		target.store.set("fresh-pinned-0", {
			code: "ORIGINAL",
			createdAt: 1,
			pinned: false,
			lastAccessedAt: 1,
			sourceLength: 999,
			title: "ORIGINAL TITLE",
		});
		const originalEntry = target.store.get("fresh-pinned-0");

		stderrSpy = installStderrSpy();
		const result = await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: false,
		});

		// 3 new puts, NOT 4 — fresh-pinned-0 was skipped.
		expect(target.puts).toHaveLength(3);
		expect(result.copied).toBe(3);
		expect(result.skipped).toBe(1);
		// The pre-existing entry was NOT overwritten.
		expect(target.store.get("fresh-pinned-0")).toBe(originalEntry);
		expect(target.store.get("fresh-pinned-0").title).toBe("ORIGINAL TITLE");
	});

	// -----------------------------------------------------------------------
	// Test 6 — target.has(id) === true emits migrate_skip event
	// -----------------------------------------------------------------------
	it("migrate-to-oss with target.has(id) === true emits migrate_skip event", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();
		await target.put("fresh-pinned-0", "ORIGINAL", "<svg>original</svg>", "", 999, "ORIGINAL");

		stderrSpy = installStderrSpy();
		await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: false,
		});

		stderrSpy.flush();
		const events = stderrSpy.getEvents();
		const skipEvents = events.filter((e) => e.event === "migrate_skip");
		expect(skipEvents.length).toBeGreaterThanOrEqual(1);
		const skipped0 = skipEvents.find((e) => e.id === "fresh-pinned-0");
		expect(skipped0).toBeTruthy();
		expect(skipped0.reason).toBe("exists_in_target");
		expect(skipped0.level).toBe("info");
	});

	// -----------------------------------------------------------------------
	// Test 7 — second-run is a no-op
	// -----------------------------------------------------------------------
	it("migrate-to-oss second-run is a no-op when target already has every id", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		const target = makeStubTarget();

		// First run — 4 copies.
		stderrSpy = installStderrSpy();
		const result1 = await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: false,
		});
		expect(result1.copied).toBe(4);
		expect(result1.skipped).toBe(0);
		const firstPutsCount = target.puts.length;

		// Second run — 0 copies, 4 skipped.
		stderrSpy.flush();
		const result2 = await runMigration({
			sourceStorage: fixture.storage,
			targetStorage: target,
			dryRun: false,
		});
		expect(result2.copied).toBe(0);
		expect(result2.skipped).toBe(4);
		expect(result2.dryRun).toBe(false);
		// No new puts on the second run.
		expect(target.puts.length).toBe(firstPutsCount);
		// All migrate_skip events on the second run.
		stderrSpy.flush();
		const events2 = stderrSpy.getEvents();
		const skipEvents = events2.filter((e) => e.event === "migrate_skip");
		expect(skipEvents).toHaveLength(4);
	});

	// -----------------------------------------------------------------------
	// Test 8 — --source-dir overrides MERMAID_RENDERER_DATA
	// -----------------------------------------------------------------------
	it("migrate-to-oss --source-dir overrides MERMAID_RENDERER_DATA", async () => {
		// Build the fixture in a known location.
		const customDir = await mkdtemp(join(tmpdir(), "migrate-custom-"));
		try {
			const fixture = await makeLocalFixture(customDir);
			const target = makeStubTarget();

			// Pass MERMAID_RENDERER_DATA pointing at a DIFFERENT
			// (empty) dir, then override via --source-dir to point
			// at the fixture. The migration must read from the
			// --source-dir path.
			const wrongDir = await mkdtemp(join(tmpdir(), "migrate-empty-"));
			try {
				const oldEnv = process.env.MERMAID_RENDERER_DATA;
				process.env.MERMAID_RENDERER_DATA = wrongDir;
				stderrSpy = installStderrSpy();
				try {
					const result = await runMigration({
						env: process.env,
						sourceDir: customDir, // the --source-dir override
						dryRun: false,
						targetStorage: target,
					});
					// 4 copies come from the fixture in customDir, not
					// from the wrongDir (which is empty).
					expect(result.copied).toBe(4);
					expect(target.puts.map((p) => p.id).sort()).toEqual([...fixture.survivingIds].sort());
				} finally {
					if (oldEnv === undefined) delete process.env.MERMAID_RENDERER_DATA;
					else process.env.MERMAID_RENDERER_DATA = oldEnv;
				}
			} finally {
				await rm(wrongDir, { recursive: true, force: true });
			}
		} finally {
			await rm(customDir, { recursive: true, force: true });
		}
	});

	// -----------------------------------------------------------------------
	// Test 9 — missing required env vars throws OssEnvInvalidError
	// -----------------------------------------------------------------------
	it("migrate-to-oss missing required env vars throws OssEnvInvalidError with human message", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		stderrSpy = installStderrSpy();

		// Empty env → no MERMAID_OSS_* vars → OssStorageFromEnv throws.
		// Do NOT pass `targetStorage` — we want the factory to attempt
		// construction so the env-validation runs.
		await expect(runMigration({
			env: { /* nothing */ },
			sourceStorage: fixture.storage,
			dryRun: false,
		})).rejects.toBeInstanceOf(OssEnvInvalidError);

		// The factory already emitted oss_env_invalid (R008) and the
		// migration CLI added a human-readable line on stderr.
		stderrSpy.flush();
		const stderrText = stderrSpy.getLines().join("\n");
		expect(stderrText).toMatch(/OssStorage env invalid/);
		expect(stderrText).toMatch(/MERMAID_OSS_ENDPOINT/);
	});

	// -----------------------------------------------------------------------
	// Test 9 (--help) — verify the CLI's --help path prints usage
	// to stdout and exits 0. We don't spawn a child process — we
	// import the parseArgs + printHelp surface directly and call it.
	// -----------------------------------------------------------------------
	it("migrate-to-oss --help flag prints usage to stdout", async () => {
		// We exercise the CLI's argv-handling surface without invoking
		// main() (which calls process.exit). parseArgs/printHelp are
		// local to the script — exercise them by re-spawning the
		// module's main() path with a stubbed process.exit. The
		// simpler way: drive the script via `node` in a child
		// process and inspect its stdout.
		const { spawn } = await import("node:child_process");
		const scriptPath = join(REPO_ROOT_FROM_TEST, "bin", "migrate-to-oss.mjs");
		const child = spawn(process.execPath, [scriptPath, "--help"], {
			cwd: REPO_ROOT_FROM_TEST,
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => { out += d.toString("utf-8"); });
		child.stderr.on("data", (d) => { err += d.toString("utf-8"); });
		const code = await new Promise((resolveCode) => child.once("close", (c) => resolveCode(c)));
		expect(code).toBe(0);
		expect(out).toContain("Usage");
		expect(out).toContain("--dry-run");
		expect(out).toContain("--source-dir");
		expect(err).toBe(""); // --help should not emit any structured log events
	});

	// -----------------------------------------------------------------------
	// Test 10 — formatSummary shape
	// -----------------------------------------------------------------------
	it("formatSummary returns a single-line human summary with copied/skipped + source/target stats", () => {
		const fakeResult = {
			copied: 4,
			skipped: 0,
			readFailed: 0,
			dryRun: false,
			sourceStats: { total: 4, pinned: 4, unpinned: 0 },
			targetStats: { total: 4, pinned: 4, unpinned: 0 },
			idsCopied: ["a", "b", "c", "d"],
			idsSkipped: [],
		};
		const line = formatSummary(fakeResult);
		expect(line).toContain("Migration complete");
		expect(line).toContain("copied=4");
		expect(line).toContain("skipped=0");
		// The source/target stats are JSON-serialized.
		expect(line).toContain(JSON.stringify(fakeResult.sourceStats));
		expect(line).toContain(JSON.stringify(fakeResult.targetStats));
		// No trailing newline (the CLI adds it).
		expect(line.endsWith("\n")).toBe(false);
		// Dry-run variant says "dry run".
		const dryLine = formatSummary({ ...fakeResult, dryRun: true, copied: 4, skipped: 0 });
		expect(dryLine).toContain("Migration (dry run) complete");
	});
});
