// tests/integration/oss-backend-boot.test.mjs — locks M002/S01/T03 wiring.
//
// What this file locks:
//   - When MERMAID_RENDERER_BACKEND=oss is set and the required
//     MERMAID_OSS_* env vars are absent (or empty), src/server.mjs
//     (a) emits a structured stderr `oss_env_invalid` log line from
//     the factory, (b) emits a structured stderr `oss_init_failed`
//     log line from the boot-path catch, and (c) calls process.exit(1)
//     so the operator sees a clear boot failure (not a 2-second hang
//     followed by a confusing stdio timeout from the parent MCP
//     launcher).
//   - The reported missing-var list includes every required
//     MERMAID_OSS_* var name (mirrors the order contract from
//     oss-env.test.mjs).
//
// What this file does NOT lock (deferred to T04):
//   - The boot log line `data: <bucket>` when the env is valid (needs
//     a real S3/MinIO to round-trip the bucket name through the
//     StorageBackend.root field). T04's integration test exercises
//     this end-to-end against Docker MinIO at 127.0.0.1:9000.
//
// The test does NOT use tests/helpers/server.mjs because that helper
// is designed to kill alive MCP servers (the SIGTERM/SIGKILL
// escalation at 150ms/1200ms is too aggressive for a server that
// naturally exits ~600-800ms into its boot). Spawning the child
// directly with child_process and awaiting the natural 'exit' event
// gives a clean, deterministic read of the real termination code.

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
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
function spawnAndWaitForExit(env) {
	return new Promise((resolveExit, rejectExit) => {
		const child = spawn("node", [SERVER_PATH], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf-8");
		});
		// We don't write to stdin — the test's boot path calls
		// process.exit(1) before the MCP transport starts reading.
		// Closing stdin defensively avoids holding the pipe open
		// past the natural exit.
		child.stdin.end();
		child.once("error", rejectExit);
		child.once("exit", (code) => resolveExit({ code, stderr }));
	});
}

describe("server boot — oss backend (T03 wiring)", () => {
	it("exits with code 1 and emits oss_init_failed + oss_env_invalid when required MERMAID_OSS_* env vars are missing", async () => {
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
		// The factory throws OssEnvInvalidError; the boot-path catch
		// logs oss_init_failed and calls process.exit(1). We expect
		// the real exit code (1), NOT a SIGTERM/SIGKILL-induced null.
		expect(code).toBe(1);
		expect(stderr).toContain("oss_init_failed");
		expect(stderr).toContain("oss_env_invalid");
		// The factory reports the missing list in stable
		// REQUIRED_ENV_VARS declaration order; all 5 names must
		// appear in the stderr log lines (one in oss_env_invalid,
		// one in the human-readable oss_init_failed message).
		for (const v of REQUIRED_VARS) {
			expect(stderr).toContain(v);
		}
	});
});
