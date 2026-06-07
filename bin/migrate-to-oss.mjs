#!/usr/bin/env node
// bin/migrate-to-oss.mjs — one-shot LocalFsStorage → OssStorage migration CLI.
//
// Operators run this ONCE during the v0.2.0 → v0.3.0 upgrade: the
// local data dir (under MERMAID_RENDERER_DATA) gets copied into the
// S3-compatible bucket configured by the MERMAID_OSS_* env vars.
//
// Invariants the CLI guarantees:
//   1. 4-of-5 entries copied when the source has the slice's
//      demo mix (3 fresh+pinned, 1 expired-but-pinned,
//      1 expired-and-unpinned). The expired-unpinned entry is
//      dropped by the source's TTL sweep on load() — the migration
//      sees the post-sweep state, not the raw on-disk state.
//   2. createdAt, title, pinned are byte-equal on the target. The
//      createdAt on the target is set by OssStorage.put() to
//      Date.now() at put-time (not the source's createdAt) — this
//      is the documented LocalFsStorage/OssStorage behaviour, not
//      a migration bug. For the migration we re-stamp createdAt
//      on the target entry so the source's age is preserved; the
//      `lastAccessedAt` field is also re-stamped. The idempotency
//      re-run is a no-op (target.has(id) short-circuits before
//      the put).
//   3. Re-running is a no-op (idempotent).
//   4. --dry-run reports what WOULD be copied without writing.
//
// CLI surface (per the S02 task plan):
//   --dry-run               boolean
//   --source-dir <path>     override MERMAID_RENDERER_DATA
//   --help                  print usage to stdout, exit 0
//
// Observability (6 new structured stderr events, R008 shape):
//   migrate_start, migrate_copy, migrate_skip, migrate_dry_run,
//   migrate_read_failed, migrate_done
// The CLI's stdout is reserved for the human summary line; stderr
// is the structured event stream (matches the project's stdio-MCP
// convention — see R008 + MEM015).
//
// Exit codes:
//   0   success (copy or dry-run)
//   1   env construction failure (OssEnvInvalidError) — the
//       factory has already emitted `oss_env_invalid`; we add a
//       human-readable line on stderr and exit 1.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../src/logger.mjs";
import { LocalFsStorage } from "../src/storage/LocalFsStorage.mjs";
import { OssEnvInvalidError, OssStorageFromEnv } from "../src/storage/OssStorage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Argv parsing — hand-rolled, no deps. Supports the three flags the
// S02 task plan names: --dry-run, --source-dir <path>, --help. The
// parseArgs function returns the parsed flag bag + any error / help
// signal the caller should handle. We do not support `--key=value`
// shorthand — matches the bin/start.sh + bin/stop.sh shell-script
// idiom in this repo.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ParsedArgs
 * @property {boolean} dryRun
 * @property {string} sourceDir
 * @property {boolean} help
 * @property {string} [error]   populated when argv is malformed
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
	const out = {
		dryRun: false,
		sourceDir: process.env.MERMAID_RENDERER_DATA || join(REPO_ROOT, "data"),
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") {
			out.help = true;
		} else if (a === "--dry-run") {
			out.dryRun = true;
		} else if (a === "--source-dir") {
			const next = argv[i + 1];
			if (typeof next !== "string" || next.length === 0) {
				return { ...out, error: "--source-dir requires a path argument" };
			}
			out.sourceDir = next;
			i++;
		} else if (a.startsWith("--source-dir=")) {
			const v = a.slice("--source-dir=".length);
			if (v.length === 0) {
				return { ...out, error: "--source-dir requires a path argument" };
			}
			out.sourceDir = v;
		} else if (a === "--") {
			// explicit end-of-options; ignore the rest
			break;
		} else {
			return { ...out, error: `unknown argument: ${a}` };
		}
	}
	return out;
}

function printHelp() {
	const lines = [
		"Usage: node bin/migrate-to-oss.mjs [--dry-run] [--source-dir <path>] [--help]",
		"",
		"  One-shot LocalFsStorage -> OssStorage migration utility.",
		"  Reads entries from the local data dir (MERMAID_RENDERER_DATA or",
		"  --source-dir) and copies them into the S3-compatible bucket",
		"  configured by the MERMAID_OSS_* env vars (see README).",
		"",
		"  --dry-run         report what would be copied without writing",
		"  --source-dir <p>  override MERMAID_RENDERER_DATA",
		"  --help, -h        print this message and exit",
		"",
		"  Re-running is a no-op: target.has(id) is checked before each put.",
		"  Required env vars: MERMAID_OSS_ENDPOINT, MERMAID_OSS_REGION,",
		"  MERMAID_OSS_ACCESS_KEY_ID, MERMAID_OSS_SECRET_ACCESS_KEY,",
		"  MERMAID_OSS_BUCKET.",
	];
	for (const line of lines) process.stdout.write(line + "\n");
}

// ---------------------------------------------------------------------------
// Main — exported as a function so the unit test can drive the
// same code path the CLI runs, capturing the structured events on
// stderr and the summary on stdout without spawning a child process.
// The unit test imports `runMigration` and asserts on its return
// value; the CLI's process-stdin handling lives in main().
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   sourceDir?: string,
 *   dryRun?: boolean,
 *   sourceStorage?: LocalFsStorage,    // optional injection for tests
 *   targetStorage?: import("../src/storage/OssStorage.mjs").OssStorage, // optional injection for tests
 * }} [opts]
 * @returns {Promise<{
 *   copied: number,
 *   skipped: number,
 *   readFailed: number,
 *   dryRun: boolean,
 *   sourceStats: { total: number, pinned: number, unpinned: number },
 *   targetStats: { total: number, pinned: number, unpinned: number },
 *   idsCopied: string[],
 *   idsSkipped: string[],
 * }>}
 */
export async function runMigration(opts = {}) {
	const env = opts.env || process.env;
	const sourceDir = typeof opts.sourceDir === "string" && opts.sourceDir.length > 0
		? opts.sourceDir
		: (env.MERMAID_RENDERER_DATA || join(REPO_ROOT, "data"));
	const dryRun = !!opts.dryRun;

	let source = opts.sourceStorage || null;
	let target = opts.targetStorage || null;
	let constructedTarget = false;

	// Step 1: source. The unit test may inject a pre-built source
	// (avoids reading from disk in a stub-only test). The integration
	// test injects a makeLocalFixture-built storage. The CLI flow
	// constructs a new LocalFsStorage rooted at sourceDir and runs
	// .load() so the source's TTL sweep runs BEFORE the migration
	// sees the store (matches the documented behaviour — the
	// migration sees the post-sweep state, not the raw disk).
	if (!source) {
		source = new LocalFsStorage(sourceDir, { counters: null, logger: log });
		await source.load();
	}

	// Step 2: target. We use OssStorageFromEnv directly (NOT
	// buildStorageFromEnv) because the migration CLI explicitly wants
	// an OssStorage — there is no env-driven backend switch for the
	// target, the whole point of this CLI is to write to a bucket.
	// createBucket:true is the dev-time MinIO posture (the operator
	// running this CLI is almost always writing to a fresh bucket);
	// readTimeoutMs is bumped to 30s to handle the worst-case slow
	// network without the R005 5s default timing out.
	if (!target) {
		try {
			target = OssStorageFromEnv(env, {
				counters: null,
				logger: log,
				createBucket: true,
				readTimeoutMs: 30_000,
			});
		} catch (err) {
			if (err instanceof OssEnvInvalidError) {
				// OssStorageFromEnv already emitted `oss_env_invalid` with
				// the missing-var list. Add a human-readable line on stderr
				// so the operator running the CLI interactively sees a
				// clear "set these env vars" message, not just a JSON log
				// line. Do not duplicate the structured log event.
				process.stderr.write(
					`migrate-to-oss: OssStorage env invalid; missing required vars: ${err.missing.join(", ")}\n`,
				);
				// Re-throw so the CLI's caller (process entry, unit test)
				// sees a non-zero exit. The unit test that asserts on
				// the exit-1 path will catch the throw at its own seam.
				throw err;
			}
			throw err;
		}
		await target.load();
		constructedTarget = true;
	}

	// Step 3: enumerate the source's post-sweep store directly
	// (source.store.entries() preserves the id from the Map key —
	// source.list() projects {id, ...entry} but strips the id from
	// the key position, which would require us to destructure).
	const idsCopied = [];
	const idsSkipped = [];
	let readFailed = 0;
	let copied = 0;
	let skipped = 0;

	// Snapshot the ids to avoid mutation-during-iteration (the
	// loop body does not mutate the source.store, but the snapshot
	// makes the loop deterministic for the unit test's stub
	// backend that re-emits put() events).
	const ids = [...source.store.keys()];

	log({
		event: "migrate_start",
		level: "info",
		sourceDir,
		entryCount: ids.length,
		dryRun,
	});

	for (const id of ids) {
		// Idempotency: skip entries the target already has. target.has()
		// is a sync in-memory Map lookup on the loaded store.json — no
		// S3 round-trip. A second run is exactly `skipped = ids.length`,
		// `copied = 0`, no PutObject calls.
		if (target.has(id)) {
			skipped++;
			idsSkipped.push(id);
			log({
				event: "migrate_skip",
				level: "info",
				id,
				reason: "exists_in_target",
			});
			continue;
		}

		const entry = source.getMetadata(id);
		if (!entry) {
			// Map lost the entry mid-iteration (sweep raced the
			// load). Treat as a read failure — keep the batch
			// going, do not crash.
			readFailed++;
			log({
				event: "migrate_read_failed",
				level: "error",
				id,
				reason: "entry_missing",
			});
			continue;
		}

		const svg = await source.readSvg(id);
		if (svg === null || svg === undefined) {
			// A real data inconsistency — the store has the id
			// but the blob is missing. Do not crash; the rest of
			// the batch can still be migrated.
			readFailed++;
			log({
				event: "migrate_read_failed",
				level: "error",
				id,
				reason: "blob_missing",
			});
			continue;
		}

		if (dryRun) {
			log({
				event: "migrate_dry_run",
				level: "info",
				id,
				title: entry.title,
				pinned: !!entry.pinned,
				bytes: svg.length,
			});
			copied++;
			idsCopied.push(id);
			continue;
		}

		// Real copy. OssStorage.put() always sets
		// createdAt=Date.now(); the migration wants the source's
		// age preserved (so the 7-day TTL behaviour is identical
		// after migration). The put-then-mutate pattern is the
		// documented way to do this — put() returns the new
		// entry, then we overwrite createdAt/lastAccessedAt and
		// call target.save() to persist. The plan's
		// migration invariant is "byte-equal createdAt / title /
		// pinned" — we re-stamp createdAt and lastAccessedAt
		// here so the post-migration stats() are identical to
		// the pre-migration stats() (modulo the expired-and-
		// unpinned entry that the source's sweep dropped).
		const newEntry = await target.put(id, entry.code, svg, entry.ascii ?? "", entry.sourceLength, entry.title);
		newEntry.createdAt = entry.createdAt;
		newEntry.lastAccessedAt = entry.lastAccessedAt;
		newEntry.pinned = !!entry.pinned;
		await target.save();

		copied++;
		idsCopied.push(id);
		log({
			event: "migrate_copy",
			level: "info",
			id,
			title: entry.title,
			pinned: !!entry.pinned,
			bytes: svg.length,
		});
	}

	const sourceStats = source.stats();
	const targetStats = target.stats();

	log({
		event: "migrate_done",
		level: "info",
		copied,
		skipped,
		readFailed,
		dryRun,
		source: sourceStats,
		target: targetStats,
	});

	// Best-effort cleanup of the test-injected target's load()
	// side effects — the CLI's main() does not call any of these,
	// so this branch is a no-op in the real CLI path. Marked as
	// constructedTarget so future cleanup seams can branch on it.
	void constructedTarget;

	return {
		copied,
		skipped,
		readFailed,
		dryRun,
		sourceStats,
		targetStats,
		idsCopied,
		idsSkipped,
	};
}

/**
 * Format the human summary line that the CLI writes to stdout.
 * Extracted as a pure function so the unit test can assert on the
 * exact shape without depending on the order of JSON serialization.
 *
 * @param {Awaited<ReturnType<typeof runMigration>>} result
 * @returns {string}
 */
export function formatSummary(result) {
	const dryTag = result.dryRun ? " (dry run)" : "";
	return `Migration${dryTag} complete: copied=${result.copied} skipped=${result.skipped}${result.readFailed > 0 ? ` read_failed=${result.readFailed}` : ""} (source ${JSON.stringify(result.sourceStats)} → target ${JSON.stringify(result.targetStats)})`;
}

// ---------------------------------------------------------------------------
// CLI entry point — argv parsing, --help, env-construction error handling,
// the single-line stdout summary, and process.exit.
//
// We detect "called as the script's main module" via import.meta.url ===
// process.argv[1] (the standard ESM main-module heuristic). This keeps
// `runMigration` exportable to the unit test without firing the
// CLI's process.exit on import.
// ---------------------------------------------------------------------------

function isMainModule() {
	try {
		const thisFile = fileURLToPath(import.meta.url);
		const invoked = process.argv[1];
		if (typeof invoked !== "string") return false;
		// Resolve both to absolute paths so a relative invocation
		// (`node bin/migrate-to-oss.mjs`) is detected the same way as
		// an absolute one (`node /full/path/bin/migrate-to-oss.mjs`).
		return resolve(thisFile) === resolve(invoked);
	} catch {
		return false;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.error) {
		process.stderr.write(`migrate-to-oss: ${args.error}\n`);
		process.stderr.write("Run with --help for usage.\n");
		process.exit(2);
	}
	if (args.help) {
		printHelp();
		process.exit(0);
	}
	let result;
	try {
		result = await runMigration({
			env: process.env,
			sourceDir: args.sourceDir,
			dryRun: args.dryRun,
		});
	} catch (err) {
		// OssEnvInvalidError is the only handled failure mode for
		// the CLI's "happy path" — the factory has already emitted
		// oss_env_invalid and we added a human line on stderr in
		// runMigration. Exit 1 so the operator's shell prompt sees
		// a failure (not a "completed with 0 copied" line).
		if (err instanceof OssEnvInvalidError) {
			process.exit(1);
		}
		// Any other error is a real bug — surface the message + stack
		// on stderr and exit 1.
		process.stderr.write(`migrate-to-oss: ${err?.stack || err?.message || err}\n`);
		process.exit(1);
	}
	process.stdout.write(formatSummary(result) + "\n");
	process.exit(0);
}

if (isMainModule()) {
	main();
}
