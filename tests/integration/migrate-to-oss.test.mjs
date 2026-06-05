// tests/integration/migrate-to-oss.test.mjs — M002/S02 integration-closure
// test. Drives the real `bin/migrate-to-oss.mjs` CLI as a child process
// against a real S3-compatible endpoint (canonical: MinIO on
// 127.0.0.1:9000) and proves the slice's full demo:
//
//   1. 4-of-5 entries copied from a 5-entry LocalFsStorage fixture into a
//      real bucket, with createdAt / title / pinned / sourceLength /
//      code byte-equal between source and target.
//   2. A second run is a no-op (idempotent — copied=0, skipped=4).
//   3. `--dry-run` reports what would be copied but writes 0 entries to
//      the bucket.
//   4. After migration, spawning the server with
//      MERMAID_RENDERER_BACKEND=oss and calling list_diagrams over stdio
//      JSON-RPC returns the same 4 surviving entries as the pre-migration
//      LocalFsStorage state (title/pinned/createdAt byte-equal).
//   5. After migration, calling search_diagrams over the same server
//      returns the same id/titleMatch/snippet as the pre-migration
//      LocalFsStorage search.
//   6. Running the CLI with no MERMAID_OSS_* env vars exits 1 with a
//      human-readable "missing required vars" message and the stable
//      5-var list on stderr (Q7 negative path).
//
// Skip semantics: when MERMAID_OSS_ENDPOINT is unset, OR the endpoint
// does not accept a TCP connect within 1s, the file skips the entire
// suite with a clear skip reason (mirrors stdio-mcp-oss.test.mjs — the
// "MEM036 opt-in by env" gate). This keeps `npm test` green on machines
// without Docker/MinIO; the test is opt-in by exporting MERMAID_OSS_*.
//
// Per-test isolation: a randomized MERMAID_OSS_PREFIX
// (mcp-s02-migrate-<rand>) is generated once at module-load and shared
// across all it() blocks in this file. afterEach sweeps the prefix via
// ListObjectsV2 + DeleteObjects so each test starts with an empty
// bucket under the prefix.
//
// Proof artifacts: this file does NOT write on-disk proof files. The
// slice's demo (S02) does not require file://-style HTML viewers
// (unlike S01's T04) — the structured events from the CLI and the
// stdio-MCP server's list/search tool responses are captured inline
// in the test's vitest reporter. The "dry-run output" that S02's demo
// promises is asserted via the 4 `migrate_dry_run` event count + the
// `bucket-is-empty` after-state, both of which are in-process.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { makeLocalFixture, MIGRATE_FIXTURE_SEED } from "../helpers/migrate-fixture.mjs";
import { spawnServer } from "../helpers/server.mjs";
import { probeForSkip, ensureOssBucket, sweepOssPrefix } from "../helpers/oss-fixture.mjs";
import { OssStorage } from "../../src/storage/OssStorage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_FROM_TEST = resolve(__dirname, "..", "..");
const MIGRATE_SCRIPT = resolve(REPO_ROOT_FROM_TEST, "bin", "migrate-to-oss.mjs");

const VALID_GRAPH = "graph TD\n  A-->B";
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "vitest-migrate", version: "0.0.0" };

// ---------------------------------------------------------------------------
// Env wiring — read the same MERMAID_OSS_* vars stdio-mcp-oss.test.mjs
// reads (D016), with MERMAID_OSS_PREFIX randomized per run for isolation.
// ---------------------------------------------------------------------------

const endpoint = process.env.MERMAID_OSS_ENDPOINT;
const region = process.env.MERMAID_OSS_REGION || "us-east-1";
const accessKeyId = process.env.MERMAID_OSS_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.MERMAID_OSS_SECRET_ACCESS_KEY || "";
const bucket = process.env.MERMAID_OSS_BUCKET || "";
const randomSuffix = randomBytes(6).toString("hex");
const testPrefix = process.env.MERMAID_OSS_PREFIX
	? `${process.env.MERMAID_OSS_PREFIX}-migrate-${randomSuffix}`
	: `mcp-s02-migrate-${randomSuffix}`;

const ossEnv = {
	MERMAID_OSS_ENDPOINT: endpoint,
	MERMAID_OSS_REGION: region,
	MERMAID_OSS_ACCESS_KEY_ID: accessKeyId,
	MERMAID_OSS_SECRET_ACCESS_KEY: secretAccessKey,
	MERMAID_OSS_BUCKET: bucket,
	MERMAID_OSS_FORCE_PATH_STYLE: "true",
	MERMAID_OSS_PREFIX: testPrefix,
};

// Gate the whole file on a TCP probe to MERMAID_OSS_ENDPOINT. Mirrors
// stdio-mcp-oss.test.mjs's pattern (MEM036 — opt-in via env + 1s probe).
const initialProbe = await probeForSkip(endpoint, 1000);
const SUITE_SHOULD_RUN = initialProbe.reachable;

if (!SUITE_SHOULD_RUN) {
	// eslint-disable-next-line no-console
	console.warn(`[migrate-to-oss] skipped — ${initialProbe.reason}`);
}

// ---------------------------------------------------------------------------
// Helpers — child-process driver for the migration CLI, structured
// event parser for stderr, server-driver adapter.
// ---------------------------------------------------------------------------

/**
 * Spawn `node bin/migrate-to-oss.mjs` as a child process. The child
 * inherits a CLEAN env (no MERMAID_RENDERER_DATA, no MERMAID_RENDERER_BACKEND)
 * plus the OSS-related vars we explicitly inject — this matches the
 * real CLI invocation shape (`oss_*` + optional `--source-dir`) and
 * avoids any leakage from the test runner's env.
 *
 * @param {string[]} args                 argv passed to the CLI
 * @param {Record<string, string>} extraEnv  extra env vars to merge
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, events: object[]}>}
 */
function runMigrateCli(args, extraEnv) {
	return new Promise((resolveDone) => {
		// Explicit env: PATH (so node can resolve its internals) + the
		// OSS env + caller-supplied extras. Do NOT spread process.env —
		// that would leak MERMAID_RENDERER_DATA / MERMAID_OSS_* from the
		// test runner into the child, defeating the test 6 negative case
		// ("all MERMAID_OSS_* unset" must truly be unset).
		const childEnv = {
			PATH: process.env.PATH || "",
			...ossEnv,
			...(extraEnv || {}),
		};
		const child = spawn(process.execPath, [MIGRATE_SCRIPT, ...args], {
			cwd: REPO_ROOT_FROM_TEST,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
		child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });
		child.on("close", (code) => {
			// Parse the structured events out of stderr. Each event is
			// one JSON object per line. Non-JSON lines (e.g. the human
			// "missing required vars" line in test 6) are preserved on
			// the `stderr` string but not in `events`.
			const events = stderr
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => {
					try { return JSON.parse(l); } catch { return null; }
				})
				.filter((o) => o && typeof o === "object" && typeof o.event === "string");
			resolveDone({ exitCode: code, stdout, stderr, events });
		});
	});
}

/** Parse a tools/call result.content[0].text payload as JSON. */
function parseCallText(callResult) {
	expect(callResult).toBeDefined();
	expect(Array.isArray(callResult.content)).toBe(true);
	expect(callResult.content.length).toBeGreaterThan(0);
	const first = callResult.content[0];
	expect(first.type).toBe("text");
	expect(typeof first.text).toBe("string");
	return JSON.parse(first.text);
}

async function initialize(server) {
	return server.send("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

/** Strip the fields that vary between two independent renders (e.g. lastAccessedAt may differ by ms). */
function entryStableFields(e) {
	return {
		id: e.id,
		title: e.title,
		code: e.code,
		createdAt: e.createdAt,
		sourceLength: e.sourceLength,
		pinned: e.pinned,
	};
}

describe.skipIf(!SUITE_SHOULD_RUN)("migrate-to-oss integration (M002/S02)", () => {
	/** @type {S3Client | null} */
	let directClient;
	/** @type {string|null} */
	let tmpRoot = null;
	/** @type {ReturnType<typeof spawnServer> | null} */
	let server = null;

	beforeAll(async () => {
		directClient = new S3Client({
			region,
			endpoint,
			forcePathStyle: true,
			credentials: { accessKeyId, secretAccessKey },
		});
		try {
			await ensureOssBucket(directClient, bucket, true);
		} catch (e) {
			throw new Error(`ensureOssBucket("${bucket}") failed: ${e?.message || e}`);
		}
	});

	beforeEach(async () => {
		// Each test gets a fresh tmp source dir so the LocalFsStorage
		// fixture starts clean (no leftover blobs / store.json from a
		// previous test).
		tmpRoot = await mkdtemp(join(tmpdir(), "migrate-int-"));
	});

	afterEach(async () => {
		if (server) {
			try { await server.close(); } catch { /* best-effort */ }
			server = null;
		}
		if (tmpRoot) {
			try { await rm(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
			tmpRoot = null;
		}
		if (directClient) {
			try { await sweepOssPrefix(directClient, bucket, testPrefix); } catch { /* best-effort */ }
		}
	});

	// -------------------------------------------------------------------------
	// Test 1 — 4-of-5 fixture entries copied to a real bucket
	// -------------------------------------------------------------------------
	it("1. migrate-to-oss copies 4 of 5 fixture entries to a real bucket (createdAt/title/pinned byte-equal)", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		// Confirm the source side already saw the sweep (4 entries
		// pre-migration — this is what the CLI will copy).
		expect(fixture.storage.store.size).toBe(4);
		expect(fixture.survivingIds).toHaveLength(4);

		const result = await runMigrateCli(["--source-dir", tmpRoot]);
		expect(result.exitCode).toBe(0);
		// 4 migrate_copy events, 1 migrate_start, 1 migrate_done.
		const copyEvents = result.events.filter((e) => e.event === "migrate_copy");
		const startEvents = result.events.filter((e) => e.event === "migrate_start");
		const doneEvents = result.events.filter((e) => e.event === "migrate_done");
		expect(startEvents).toHaveLength(1);
		expect(copyEvents).toHaveLength(4);
		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0].copied).toBe(4);
		expect(doneEvents[0].skipped).toBe(0);
		// Stdout has the human summary line.
		expect(result.stdout).toContain("Migration complete");
		expect(result.stdout).toContain("copied=4");
		expect(result.stdout).toContain("skipped=0");

		// Load a FRESH OssStorage from the same bucket + prefix and
		// verify the post-migration state byte-equal against the
		// pre-migration LocalFsStorage.
		const target = new OssStorage({
			bucket,
			prefix: testPrefix,
			client: directClient,
		});
		await target.load();

		expect(target.store.size).toBe(4);
		const targetStats = target.stats();
		expect(targetStats.total).toBe(4);
		expect(targetStats.pinned).toBe(4); // all 4 surviving entries are pinned
		expect(targetStats.unpinned).toBe(0);

		// The expired-unpinned id is NOT in the target.
		expect(target.has("expired-unpinned")).toBe(false);

		// The 4 surviving ids ARE in the target with title/pinned/
		// sourceLength/createdAt/code byte-equal to the pre-migration
		// LocalFsStorage state.
		for (const id of fixture.survivingIds) {
			const targetEntry = target.getMetadata(id);
			const sourceEntry = fixture.storage.getMetadata(id);
			expect(targetEntry, `target missing id ${id}`).toBeTruthy();
			expect(sourceEntry, `source missing id ${id}`).toBeTruthy();
			expect(targetEntry.title).toBe(sourceEntry.title);
			expect(targetEntry.pinned).toBe(sourceEntry.pinned);
			expect(targetEntry.code).toBe(sourceEntry.code);
			expect(targetEntry.sourceLength).toBe(sourceEntry.sourceLength);
			// createdAt is re-stamped to the source's value, not
			// Date.now() at put-time — that's the S02 invariant.
			expect(targetEntry.createdAt).toBe(sourceEntry.createdAt);
			// The source's svg body is round-tripped through S3
			// byte-equal (the CLI uses source.readSvg + target.put).
			const seed = MIGRATE_FIXTURE_SEED.find((e) => e.id === id);
			expect(seed).toBeTruthy();
			const roundTrippedSvg = await target.readSvg(id);
			expect(roundTrippedSvg).toBe(seed.svg);
		}
	});

	// -------------------------------------------------------------------------
	// Test 2 — second run is a no-op
	// -------------------------------------------------------------------------
	it("2. migrate-to-oss second run on the same bucket is a no-op (copied=0 skipped=4)", async () => {
		const fixture = await makeLocalFixture(tmpRoot);

		// First run — prime the bucket.
		const first = await runMigrateCli(["--source-dir", tmpRoot]);
		expect(first.exitCode).toBe(0);
		expect(first.events.filter((e) => e.event === "migrate_copy")).toHaveLength(4);

		// Second run on the same bucket — the CLI's target.has(id)
		// short-circuits before every put, so 4 skips and 0 copies.
		const second = await runMigrateCli(["--source-dir", tmpRoot]);
		expect(second.exitCode).toBe(0);
		const secondCopies = second.events.filter((e) => e.event === "migrate_copy");
		const secondSkips = second.events.filter((e) => e.event === "migrate_skip");
		const secondDone = second.events.filter((e) => e.event === "migrate_done");
		expect(secondCopies).toHaveLength(0);
		expect(secondSkips).toHaveLength(4);
		expect(secondDone).toHaveLength(1);
		expect(secondDone[0].copied).toBe(0);
		expect(secondDone[0].skipped).toBe(4);
		// Every skip has the documented field shape.
		for (const s of secondSkips) {
			expect(s.level).toBe("info");
			expect(s.reason).toBe("exists_in_target");
		}
		// Skipped ids are exactly the 4 surviving ids.
		expect(secondSkips.map((e) => e.id).sort()).toEqual([...fixture.survivingIds].sort());

		// The bucket is unchanged (4 entries, same as after the first run).
		const target = new OssStorage({ bucket, prefix: testPrefix, client: directClient });
		await target.load();
		expect(target.store.size).toBe(4);
	});

	// -------------------------------------------------------------------------
	// Test 3 — --dry-run does NOT write to the bucket
	// -------------------------------------------------------------------------
	it("3. migrate-to-oss --dry-run reports what would be copied but writes 0 entries to the bucket", async () => {
		await makeLocalFixture(tmpRoot);

		const result = await runMigrateCli(["--source-dir", tmpRoot, "--dry-run"]);
		expect(result.exitCode).toBe(0);

		// 4 migrate_dry_run events for the 4 surviving entries.
		const dryRunEvents = result.events.filter((e) => e.event === "migrate_dry_run");
		expect(dryRunEvents).toHaveLength(4);
		// 0 migrate_copy events.
		expect(result.events.filter((e) => e.event === "migrate_copy")).toHaveLength(0);
		// 1 migrate_start + 1 migrate_done.
		expect(result.events.filter((e) => e.event === "migrate_start")).toHaveLength(1);
		const doneEvents = result.events.filter((e) => e.event === "migrate_done");
		expect(doneEvents).toHaveLength(1);
		expect(doneEvents[0].dryRun).toBe(true);
		// Stdout has the (dry run) tag in the summary line.
		expect(result.stdout).toContain("Migration (dry run) complete");

		// Each dry-run event has the documented field shape.
		for (const e of dryRunEvents) {
			expect(e.level).toBe("info");
			expect(typeof e.title).toBe("string");
			expect(typeof e.pinned).toBe("boolean");
			expect(typeof e.bytes).toBe("number");
		}

		// THE KEY ASSERTION: the bucket is still empty. The dry-run
		// must not have written any blob or any store.json under the
		// prefix. We verify by loading a fresh OssStorage and checking
		// that the in-memory Map is empty (sweep is a no-op on an
		// empty store). And we cross-check with a direct ListObjects
		// to catch the case where load()'s NoSuchKey-default left the
		// Map empty even though an object was written.
		const target = new OssStorage({ bucket, prefix: testPrefix, client: directClient });
		await target.load();
		expect(target.store.size).toBe(0);

		const list = await directClient.send(new ListObjectsV2Command({
			Bucket: bucket,
			Prefix: testPrefix,
		}));
		const contents = list && Array.isArray(list.Contents) ? list.Contents : [];
		expect(contents).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 4 — post-migration list parity over MERMAID_RENDERER_BACKEND=oss
	// -------------------------------------------------------------------------
	it("4. post-migration list_diagrams over MERMAID_RENDERER_BACKEND=oss returns the same 4 entries as the pre-migration LocalFsStorage state", async () => {
		const fixture = await makeLocalFixture(tmpRoot);

		// Migrate 5 → 4 into the bucket.
		const migration = await runMigrateCli(["--source-dir", tmpRoot]);
		expect(migration.exitCode).toBe(0);
		expect(migration.events.filter((e) => e.event === "migrate_copy")).toHaveLength(4);

		// Snapshot the pre-migration LocalFsStorage list BEFORE
		// spawning the server (the fixture is independent of the
		// server, but this makes the parity comparison self-evident).
		const preList = await fixture.storage.list({ limit: 100 });
		expect(preList.items).toHaveLength(4);
		// All 4 are pinned in the fixture.
		for (const item of preList.items) {
			expect(item.pinned).toBe(true);
		}

		// Spawn the server with the OSS backend + the test prefix.
		server = spawnServer({
			env: {
				MERMAID_RENDERER_BACKEND: "oss",
				...ossEnv,
			},
		});
		await initialize(server);
		const callResult = await server.send("tools/call", {
			name: "list_diagrams",
			arguments: { limit: 100 },
		});
		const postList = parseCallText(callResult);

		// 4 entries on each side, same 4 ids.
		expect(postList.items).toHaveLength(4);
		const preIds = preList.items.map((e) => e.id).sort();
		const postIds = postList.items.map((e) => e.id).sort();
		expect(postIds).toEqual(preIds);

		// Byte-equal per-entry stable fields, keyed by id.
		const preById = new Map(preList.items.map((e) => [e.id, e]));
		for (const postItem of postList.items) {
			const preItem = preById.get(postItem.id);
			expect(preItem).toBeTruthy();
			expect(entryStableFields(postItem)).toEqual(entryStableFields(preItem));
		}
	});

	// -------------------------------------------------------------------------
	// Test 5 — post-migration search parity over MERMAID_RENDERER_BACKEND=oss
	// -------------------------------------------------------------------------
	it("5. post-migration search_diagrams over MERMAID_RENDERER_BACKEND=oss returns the same id/titleMatch/snippet as the pre-migration LocalFsStorage search", async () => {
		const fixture = await makeLocalFixture(tmpRoot);
		// Migrate 5 → 4 into the bucket.
		const migration = await runMigrateCli(["--source-dir", tmpRoot]);
		expect(migration.exitCode).toBe(0);
		expect(migration.events.filter((e) => e.event === "migrate_copy")).toHaveLength(4);

		// "Fresh 0" is the title of the `fresh-pinned-0` entry — a
		// titleMatch hit. The post-migration server must return the
		// same id / titleMatch=true / snippet as the pre-migration
		// LocalFsStorage search.
		const query = "Fresh 0";
		const preSearch = await fixture.storage.search(query, { limit: 100 });
		expect(preSearch.items).toHaveLength(1);
		const preHit = preSearch.items[0];
		expect(preHit.titleMatch).toBe(true);
		expect(preHit.id).toBe("fresh-pinned-0");

		server = spawnServer({
			env: {
				MERMAID_RENDERER_BACKEND: "oss",
				...ossEnv,
			},
		});
		await initialize(server);
		const callResult = await server.send("tools/call", {
			name: "search_diagrams",
			arguments: { query, limit: 100 },
		});
		const postSearch = parseCallText(callResult);
		expect(postSearch.items).toHaveLength(1);
		const postHit = postSearch.items[0];
		// Same id, same titleMatch boolean, same snippet (snippet
		// uses buildSnippet which is pure-string + identical between
		// LocalFsStorage and OssStorage).
		expect(postHit.id).toBe(preHit.id);
		expect(postHit.title).toBe(preHit.title);
		expect(postHit.titleMatch).toBe(preHit.titleMatch);
		expect(postHit.snippet).toBe(preHit.snippet);
	});

	// -------------------------------------------------------------------------
	// Test 6 (Q7) — missing MERMAID_OSS_BUCKET exits 1 with human message
	// -------------------------------------------------------------------------
	it("6. migrate-to-oss with no MERMAID_OSS_* env vars exits 1 with a 'missing required vars' stderr line (Q7 negative)", async () => {
		await makeLocalFixture(tmpRoot);

		// Spawn the CLI with all MERMAID_OSS_* explicitly UNSET (we
		// pass `extraEnv = {}` and rely on runMigrateCli's
		// ossEnv NOT being merged — see how the helper is called with
		// `null` extraEnv for the negative path: we pass a fresh
		// `extraEnv` object that overrides ossEnv with empty values,
		// so the factory's env-validation runs against a truly empty
		// env. The PATH and node-internal lookup still works because
		// PATH is set unconditionally in runMigrateCli's childEnv.
		const result = await runMigrateCli(["--source-dir", tmpRoot], {
			// Override the OSS env to empty strings (treated as
			// "absent" by OssStorageFromEnv's typeof/length check).
			MERMAID_OSS_ENDPOINT: "",
			MERMAID_OSS_REGION: "",
			MERMAID_OSS_ACCESS_KEY_ID: "",
			MERMAID_OSS_SECRET_ACCESS_KEY: "",
			MERMAID_OSS_BUCKET: "",
			MERMAID_OSS_FORCE_PATH_STYLE: "",
			MERMAID_OSS_PREFIX: "",
		});

		expect(result.exitCode).toBe(1);
		// Stderr contains the human-readable "missing required vars" line.
		expect(result.stderr).toContain("OssStorage env invalid");
		expect(result.stderr).toContain("missing required vars");
		// All 5 required var names are named in the stable order.
		expect(result.stderr).toContain("MERMAID_OSS_ENDPOINT");
		expect(result.stderr).toContain("MERMAID_OSS_REGION");
		expect(result.stderr).toContain("MERMAID_OSS_ACCESS_KEY_ID");
		expect(result.stderr).toContain("MERMAID_OSS_SECRET_ACCESS_KEY");
		expect(result.stderr).toContain("MERMAID_OSS_BUCKET");
		// The structured `oss_env_invalid` log line was emitted by
		// the factory (R008) — present in the parsed events.
		const envInvalid = result.events.filter((e) => e.event === "oss_env_invalid");
		expect(envInvalid).toHaveLength(1);
		expect(envInvalid[0].level).toBe("error");
		expect(Array.isArray(envInvalid[0].missing)).toBe(true);
		expect(envInvalid[0].missing).toContain("MERMAID_OSS_BUCKET");

		// No migrate_start event was emitted (the failure is at env
		// construction time, before the copy loop runs).
		expect(result.events.filter((e) => e.event === "migrate_start")).toHaveLength(0);
		// The bucket was not touched.
		const target = new OssStorage({ bucket, prefix: testPrefix, client: directClient });
		await target.load();
		expect(target.store.size).toBe(0);
	});
});
