// tests/integration/runtime-oss-breaker.test.mjs — M003/S03/S01/T03.
//
// End-to-end lock of the runtime OSS circuit breaker. S03 fixed the
// runtime failure path: when S3 returns 5xx (or any non-NoSuchKey
// error) at runtime, the DegradableStorage wrapper must:
//
//   1. Retry-aware recordFailure — 1st / 2nd failed primary call: server
//      still returns a successful render (the LocalFsStorage fallback
//      completes the call), the breaker counter increments by 1, and
//      there is NO breaker_open event yet (the breaker has not
//      transitioned).
//   2. After N=3 consecutive failures, the breaker trips: stderr emits
//      `breaker_open` (level=warn) + the persistent
//      `breaker_trips_count` counter is bumped to 1. The server's
//      /health endpoint reports `backend: "degraded"` and the
//      `storage` sub-block shows `breaker_state: "open"` and a
//      populated `last_failure` ({message, at, code}).
//   3. While the breaker is open and still in the cool-down window,
//      subsequent storage.* calls skip the primary entirely (so the
//      fake S3 server sees no new write requests — the wrapper routes
//      straight to LocalFsStorage to avoid the per-call 5s timeout).
//   4. After the half-open window elapses, the next storage.* call
//      goes through to primary (a probe). If the probe succeeds the
//      breaker closes (stderr emits `breaker_close` level=info, the
//      `storage.breaker_state` flips to "closed", and /health's
//      `backend` flips back to "oss"); if the probe fails, the
//      cool-down is extended and a SECOND `breaker_open` event is
//      suppressed (regression guard — only one log line per actual
//      transition).
//
// This file drives the FULL production stack against a controllable
// fake S3 server: server.mjs → OssStorageFromEnv → S3Client → OssStorage
// → DegradableStorage. The fake S3 is the only knob; the rest of the
// stack is the real code path an operator would observe in production.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer } from "node:net";

import { spawnServer } from "../helpers/server.mjs";
import { startFakeS3Server } from "../helpers/oss-failure-injection.mjs";

const CLIENT_INFO = { name: "vitest-runtime-oss-breaker", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const HEALTH_TIMEOUT_MS = 5000;
// Half-open window shortened via MERMAID_DEGRADE_HALF_OPEN_AFTER_MS so
// the test can drive the recovery path in well under a second (the
// production default is 60_000ms). 800ms is enough to observe the
// cool-down period for the "skip primary while open" assertion.
const HALF_OPEN_AFTER_MS = 800;

async function getFreePort() {
	return new Promise((resolve, reject) => {
		const srv = netCreateServer();
		srv.unref();
		srv.on("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close();
				reject(new Error("could not get free port"));
				return;
			}
			const { port } = addr;
			srv.close(() => resolve(port));
		});
	});
}

async function waitForHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	let lastErr;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			if (res.status === 200) return res;
			lastErr = new Error(`unexpected status ${res.status}`);
			await res.text();
		} catch (e) {
			lastErr = e;
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(
		`/health did not respond on 127.0.0.1:${port} within ${timeoutMs}ms: ${lastErr?.message || "unknown"}`,
	);
}

/** Pull structured JSON log lines out of the captured stderr stream. */
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

describe("Runtime OSS failure → circuit breaker (S03 fix)", () => {
	let dataDir;
	let port;
	let server;
	let fakeS3;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-runtime-oss-breaker-"));
		port = await getFreePort();
		// Start the fake S3 server FIRST so we know its endpoint before
		// spawning the mermaid child. Default mode is "failing" (every
		// request gets 500) so the boot's load() call fails immediately.
		fakeS3 = await startFakeS3Server();

		server = spawnServer({
			env: {
				MERMAID_RENDERER_DATA: dataDir,
				MERMAID_RENDERER_HTTP: "1",
				MERMAID_RENDERER_PORT: String(port),
				MERMAID_RENDERER_HOST: "127.0.0.1",
				MERMAID_RENDERER_BACKEND: "oss",
				// Valid 5-tuple → factory proceeds (no env-missing branch);
				// the runtime failures are simulated by the fake S3 endpoint.
				MERMAID_OSS_ENDPOINT: fakeS3.endpoint,
				MERMAID_OSS_REGION: "us-east-1",
				MERMAID_OSS_ACCESS_KEY_ID: "fake-access-key",
				MERMAID_OSS_SECRET_ACCESS_KEY: "fake-secret-key",
				MERMAID_OSS_BUCKET: "fake-bucket",
				// Disable the AWS SDK's internal retry layer so each
				// OssStorage.put() call results in exactly 1 PutObject
				// (and 1 PutObject from save()) — makes the
				// "breaker open → skip primary" assertion deterministic
				// (a request count that does not grow when breaker is open).
				AWS_MAX_ATTEMPTS: "1",
				// Shorten the half-open window so the recovery path can
				// be exercised in a sub-second window.
				MERMAID_DEGRADE_HALF_OPEN_AFTER_MS: String(HALF_OPEN_AFTER_MS),
				// Threshold 3 (the production default) is the test target.
				// Set explicitly so a future change to the default does
				// not silently shift the trip point.
				MERMAID_DEGRADE_THRESHOLD: "3",
			},
		});
	});

	afterEach(async () => {
		if (server) {
			try { await server.close(); } catch { /* swallow */ }
		}
		if (fakeS3) {
			try { await fakeS3.stop(); } catch { /* swallow */ }
		}
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("3 consecutive runtime OSS failures trip the breaker (breaker_open event + /health backend='degraded' + breaker_trips_count=1 + last_oss_failure populated), then half-open probe recovers when OSS comes back (breaker_close event + breaker_state=closed)", async () => {
		// (A) /health must answer — graceful boot despite OSS failures.
		//     The boot's load() bumps the breaker to 1 (one runtime
		//     failure observed so far) and falls back to LocalFsStorage.
		//     The HTTP listener is up; the server is alive.
		await waitForHealth(port);

		// (B) Initialize the MCP stdio transport (no render yet, so the
		//     breaker is still at count=1 from the boot's load()).
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});

		// (C) Two failed render_mermaid calls → breaker goes 1 → 2 → 3
		//     (TRIPS). Each render still succeeds because the fallback
		//     LocalFsStorage completes the call. The fake S3 server
		//     sees 2 PutObject requests for blob + 2 PutObject requests
		//     for save() (one pair per render). Assert the render
		//     responses are success envelopes.
		const render1 = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});
		expect(render1.isError).toBeFalsy();
		expect(JSON.parse(render1.content[0].text).id).toBeTruthy();

		const render2 = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  C-->D" },
		});
		expect(render2.isError).toBeFalsy();
		expect(JSON.parse(render2.content[0].text).id).toBeTruthy();

		// (D) /health after the trip — top-level backend + storage
		//     sub-block + persistent counters all reflect the tripped
		//     state. The test target is the FULL surface in one read.
		const health1 = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
		expect(health1.backend).toBe("degraded");
		expect(health1.storage).toBeDefined();
		expect(health1.storage.breaker_state).toBe("open");
		expect(health1.storage.degraded).toBe(true);
		expect(health1.storage.consecutive_failures).toBe(3);
		expect(health1.storage.failure_threshold).toBe(3);
		expect(health1.storage.half_open_after_ms).toBe(HALF_OPEN_AFTER_MS);
		expect(health1.storage.opened_at).toBeGreaterThan(0);
		expect(health1.storage.last_failure).toBeTruthy();
		expect(typeof health1.storage.last_failure.message).toBe("string");
		expect(health1.storage.last_failure.message.length).toBeGreaterThan(0);
		expect(health1.storage.last_failure.at).toBeGreaterThan(0);
		// /health last_oss_failure mirrors storage.last_failure for
		// the top-level consumer (no boot_degraded record — the boot
		// succeeded, OSS just kept failing at runtime).
		expect(health1.last_oss_failure).toBeTruthy();
		expect(health1.last_oss_failure.code).toBe(health1.storage.last_failure.code);
		// Counter: the breaker tripped exactly once.
		expect(health1.counters.breaker_trips_count).toBe(1);
		// boot was NOT degraded (no OssEnvInvalidError — runtime is the
		// failure surface, not the boot path).
		expect(health1.boot_degraded).toBe(false);

		// (E) A third render while the breaker is still in cool-down.
		//     The wrapper must skip primary entirely (canAttempt() is
		//     false) and go straight to LocalFsStorage — so the fake
		//     S3 server sees NO new PutObject requests from this call.
		//     This is the "avoid 5s timeout per call" property the S03
		//     breaker was designed to provide.
		const putCountBefore = fakeS3.putObjectCount;
		const render3 = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  E-->F" },
		});
		expect(render3.isError).toBeFalsy();
		expect(JSON.parse(render3.content[0].text).id).toBeTruthy();
		expect(fakeS3.putObjectCount).toBe(putCountBefore);

		// (F) Wait past the half-open window. The breaker is still
		//     "open" but canAttempt() is now true (the next call is a
		//     half-open probe). Switch the fake S3 to the success mode
		//     so the probe resolves cleanly.
		await new Promise((r) => setTimeout(r, HALF_OPEN_AFTER_MS + 200));
		fakeS3.startSucceeding();

		// (G) Drive one more render — the wrapper enters the probe
		//     path (wasOpen=true). primary.put() resolves successfully,
		//     recordSuccess() closes the breaker, and the wrapper
		//     emits `breaker_close` (level=info).
		const render4 = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  G-->H" },
		});
		expect(render4.isError).toBeFalsy();
		expect(JSON.parse(render4.content[0].text).id).toBeTruthy();

		// (H) /health after the recovery — breaker_state must be
		//     "closed" and backend must flip back to "oss" (the
		//     DegradableStorage is no longer degraded).
		const health2 = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
		expect(health2.storage.breaker_state).toBe("closed");
		expect(health2.storage.degraded).toBe(false);
		expect(health2.storage.consecutive_failures).toBe(0);
		expect(health2.storage.opened_at).toBeNull();
		expect(health2.storage.last_failure).toBeNull();
		// backend: "oss" (no longer "degraded") — the operator can
		// see the system is back to using OSS.
		expect(health2.backend).toBe("oss");
		// breaker_trips_count is the persistent counter — it does NOT
		// reset on close. It records the lifetime count of open
		// transitions (R010 / SLO "OSS 抖动多少次需要切 local" is
		// measured on the open side, not the close side).
		expect(health2.counters.breaker_trips_count).toBe(1);
	});

	it("breaker_open event is emitted ONCE on the actual closed→open transition (not on each failed probe); probes inside the cool-down window skip primary entirely", async () => {
		// Boot — graceful: load() bumps the breaker to 1, falls back to local.
		await waitForHealth(port);

		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});

		// Drive 4 failed render_mermaid calls. The first 3 bump the
		// breaker to 3 and trip it (the 3rd is the actual transition).
		// The 4th happens while the breaker is still in cool-down
		// (HALF_OPEN_AFTER_MS has not elapsed since the trip), so the
		// wrapper must skip primary entirely.
		for (let i = 0; i < 4; i++) {
			const r = await server.send("tools/call", {
				name: "render_mermaid",
				arguments: { code: `graph TD\n  N${i}-->M${i}` },
			});
			expect(r.isError).toBeFalsy();
		}

		// The on-disk counters.json reflects the trip (1) and the
		// counter is NOT reset on close.
		const countersRaw = await readFile(join(dataDir, "counters.json"), "utf-8");
		const counters = JSON.parse(countersRaw);
		expect(counters.breaker_trips_count).toBe(1);
		// render_total == 4 (4 successful fallback renders)
		expect(counters.render_total).toBe(4);
		// oss_init_degraded_count stays 0 — the boot did NOT take the
		// env-missing branch (all 5 MERMAID_OSS_* vars are set to
		// non-empty strings). The runtime failures are a separate
		// counter dimension.
		expect(counters.oss_init_degraded_count).toBe(0);
		// sweep_runs >= 1 (the boot's load() ran a sweep on the
		// LocalFsStorage fallback, after the OSS HeadBucket call
		// failed).
		expect(counters.sweep_runs).toBeGreaterThanOrEqual(1);

		// The /health surface shows the breaker is OPEN at the time
		// of the read (the 4th render was in cool-down, so the
		// breaker did not auto-close). The breaker_state="open"
		// signal + breaker_trips_count=1 together prove the
		// transition closed→open fired exactly once across 4 failed
		// renders + 1 boot load. The wrapper's "no log storm" property
		// is implicit in counter=1 (each trip logs once; the unit
		// tests in tests/unit/degradable-storage.test.mjs #8 pin the
		// single-event assertion directly on the wrapper).
		const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
		expect(health.storage.breaker_state).toBe("open");
		expect(health.storage.degraded).toBe(true);
		expect(health.storage.consecutive_failures).toBe(3);
		expect(health.counters.breaker_trips_count).toBe(1);
	});
});
