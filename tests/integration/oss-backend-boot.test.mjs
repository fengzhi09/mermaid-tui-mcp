// tests/integration/oss-backend-boot.test.mjs — locks M003/S03/T01 boot
// degradation path: OssEnvInvalidError is optional-integration failure,
// so server.mjs must catch it, log a warn-level `oss_init_degraded` event
// (NOT the old `oss_init_failed` or pre-T01 `oss_init_failed_fallback`),
// fall back to LocalFsStorage, and continue booting.
//
// What this file locks (M003/S03/T01):
//   - When MERMAID_RENDERER_BACKEND=oss is set and the required
//     MERMAID_OSS_* env vars are absent (or empty), src/server.mjs
//     (a) emits the factory's `oss_env_invalid` log line, (b) emits a
//     boot-path `oss_init_degraded` log line (level=warn, with the
//     missing-var list and code -32006), (c) does NOT call
//     process.exit(1) — it falls back to LocalFsStorage and continues
//     to serve MCP stdio requests, (d) increments the
//     oss_init_degraded_count counter (visible via the persisted
//     counters.json on next boot, or via a /health fetch in HTTP mode).
//   - The reported missing-var list includes every required
//     MERMAID_OSS_* var name (mirrors the order contract from
//     oss-env.test.mjs).
//   - The D018 `oss_init_failed_fallback` event is REMOVED — replaced
//     by the more semantically specific `oss_init_degraded`. Asserting
//     the new name is present and the old names are absent locks
//     against silent regressions.
//
// What this file does NOT lock (deferred to T03/T04):
//   - The boot log line `data: <bucket>` when the env is valid (needs
//     a real S3/MinIO to round-trip the bucket name through the
//     StorageBackend.root field).
//   - /health.backend field (T04). The counter is observable through
//     the on-disk data/counters.json after the child exits.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "..", "src", "server.mjs");

const REQUIRED_VARS = [
	"MERMAID_OSS_ENDPOINT",
	"MERMAID_OSS_REGION",
	"MERMAID_OSS_ACCESS_KEY_ID",
	"MERMAID_OSS_SECRET_ACCESS_KEY",
	"MERMAID_OSS_BUCKET",
];

/**
 * Spawn src/server.mjs with the given child env and resolve to
 * { code, stderr } when the process exits naturally. Mirrors the
 * shape of tests/helpers/server.mjs close() but waits for the
 * 'exit' event instead of escalating to SIGTERM.
 *
 * @param {Record<string, string>} env
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function spawnAndWaitForExit(env, extraEnv) {
	return new Promise((resolveExit, rejectExit) => {
		const child = spawn("node", [SERVER_PATH], {
			env: { ...process.env, ...env, ...(extraEnv || {}) },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf-8");
		});
		// The test's boot path is graceful: server keeps running until
		// stdio closes, so closing stdin deterministically triggers
		// shutdown. (Pre-T01 the boot path called process.exit(1) and
		// stdin never mattered; now we close it explicitly to schedule
		// the natural exit and observe a clean code=0.)
		child.stdin.end();
		child.once("error", rejectExit);
		child.once("exit", (code) => resolveExit({ code, stderr }));
	});
}

/** Pull a single JSON line out of the captured stderr stream.
 *  The structured logger writes one JSON object per line, so we
 *  split on '\n' and JSON.parse each non-empty entry. */
function parseStderrEvents(stderr) {
	return stderr
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("{"))
		.map((l) => {
			try { return JSON.parse(l); } catch { return null; }
		})
		.filter(Boolean);
}

describe("server boot — oss backend (M003/S03/T01 wiring)", () => {
	it("D017/S03/T01: env invalid does NOT exit; falls back to local + logs oss_init_degraded (graceful-degradation)", async () => {
		const { code, stderr } = await spawnAndWaitForExit({
			MERMAID_RENDERER_BACKEND: "oss",
			// Override every required var to "" so the factory's
			// missing-var check fires deterministically regardless
			// of the parent shell's MERMAID_OSS_* exports. The
			// factory treats empty strings as missing (T01 contract).
			MERMAID_OSS_ENDPOINT: "",
			MERMAID_OSS_REGION: "",
			MERMAID_OSS_ACCESS_KEY_ID: "",
			MERMAID_OSS_SECRET_ACCESS_KEY: "",
			MERMAID_OSS_BUCKET: "",
		});
		// D017: server 不再 hard-exit. 0 表示 stdio closed 后自然退出.
		expect(code).toBe(0);
		// T01 contract: the new event name is `oss_init_degraded`
		// (level=warn, code=-32006, with the missing-var list). The
		// old `oss_init_failed_fallback` (D018, M002 T03) and the
		// older `oss_init_failed` (M002 pre-T03) must both be gone —
		// asserting their absence prevents silent regression.
		expect(stderr).toContain("oss_init_degraded");
		expect(stderr).not.toContain("oss_init_failed_fallback");
		expect(stderr).not.toContain('"event":"oss_init_failed"');
		// The factory's pre-throw log line is still emitted on the
		// boot path (it's the same factory that throws OssEnvInvalidError).
		expect(stderr).toContain("oss_env_invalid");

		// Structured-field assertions: parse the stderr stream and
		// pull the oss_init_degraded event so we can lock its shape
		// (level=warn, code=-32006, missing=[...], fallback="local").
		const events = parseStderrEvents(stderr);
		const degraded = events.find((e) => e.event === "oss_init_degraded");
		expect(degraded).toBeTruthy();
		expect(degraded.level).toBe("warn");
		expect(degraded.code).toBe(-32006);
		expect(degraded.fallback).toBe("local");
		expect(Array.isArray(degraded.missing)).toBe(true);
		expect(degraded.missing).toEqual(expect.arrayContaining(REQUIRED_VARS));

		// Sanity: the 5 required var names appear in the stderr stream
		// (factory's oss_env_invalid event also includes them).
		for (const v of REQUIRED_VARS) {
			expect(stderr).toContain(v);
		}
	});

	it("S03/T01: oss_init_degraded_count counter is persisted to data/counters.json on the degraded boot", async () => {
		// Spawn the server with a TEMPORARY data dir (MERMAID_RENDERER_DATA)
		// so the assertion can read the persisted counters.json without
		// polluting the developer machine's real data dir. The child
		// environment forces both the degraded-boot path AND a known
		// tmpdir.
		const { tmpdir } = await import("node:os");
		const { mkdtemp, readFile, rm } = await import("node:fs/promises");
		const { join } = await import("node:path");
		const dataDir = await mkdtemp(join(tmpdir(), "mermaid-boot-counter-"));
		try {
			const { code, stderr } = await spawnAndWaitForExit(
				{
					MERMAID_RENDERER_BACKEND: "oss",
					MERMAID_OSS_ENDPOINT: "",
					MERMAID_OSS_REGION: "",
					MERMAID_OSS_ACCESS_KEY_ID: "",
					MERMAID_OSS_SECRET_ACCESS_KEY: "",
					MERMAID_OSS_BUCKET: "",
				},
				{ MERMAID_RENDERER_DATA: dataDir },
			);
			expect(code).toBe(0);
			// The boot log line should be present, confirming the path ran.
			expect(stderr).toContain("oss_init_degraded");
			// The counter file must reflect the increment: 1 (the boot
			// path caught the env error once, fell back, and bumped
			// oss_init_degraded_count). Other keys may be 0 (they're
			// seeded on load).
			const countersRaw = await readFile(join(dataDir, "counters.json"), "utf-8");
			const counters = JSON.parse(countersRaw);
			expect(counters.oss_init_degraded_count).toBe(1);
		} finally {
			// Best-effort cleanup of the tempdir.
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

