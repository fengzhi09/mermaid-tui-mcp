// tests/integration/oss-env-degraded.test.mjs — M003/S03/T02.
//
// End-to-end lock of the S03 fix: when the server is launched with
// `MERMAID_RENDERER_BACKEND=oss` and ALL 5 `MERMAID_OSS_*` env vars
// are empty/missing, the boot path must:
//
//   1. NOT call process.exit(1). The server must keep running.
//   2. Emit the factory's `oss_env_invalid` structured log line
//      (level=error) so the operator sees the configuration issue.
//   3. Emit a `oss_init_degraded` log line at the boot catch site
//      (level=warn, code=-32006, fallback="local", missing=[...5 vars])
//      so the operator sees "I fell back gracefully, server still works".
//   4. NOT emit the old `oss_init_failed_fallback` or `oss_init_failed`
//      event names (silent regression guard).
//   5. Bump the persistent `oss_init_degraded_count` counter in
//      data/counters.json (so the value survives a restart — this is
//      the persistence proof, distinct from the in-memory /health value).
//   6. Mark `setBootDegraded(true)` + `setBootOssFailure({ts, code, msg})`
//      in the health-state module so /health can surface
//      `backend: "degraded"`, `boot_degraded: true`, and a populated
//      `last_oss_failure` object (code=-32006, ts>0, msg mentions a
//      missing var name).
//   7. Keep the stdio MCP path answering normally: `tools/list` still
//      reports 7 tools, and `tools/call render_mermaid` returns the
//      R020 success envelope with non-empty ASCII content (D017:
//      optional integration failure must not block the main flow).
//
// This file complements (does not replace) the existing
// `tests/integration/oss-backend-boot.test.mjs` (M002/S01/T01
// regression coverage) and the trailing test in `tests/integration/
// http.test.mjs` (which already exercises part of the /health surface
// in isolation). The new value is a SINGLE integrated test that locks
// all four artefacts in one run — stderr events, /health shape, stdio
// MCP ASCII render, and the persisted on-disk counters.json — so a
// future regression that breaks one but not the others still trips a
// test in this file.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer } from "node:net";

import { spawnServer } from "../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest-oss-env-degraded", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const HEALTH_TIMEOUT_MS = 5000;

// 5 required env vars — same set the factory (OssStorageFromEnv) and
// the existing oss-backend-boot.test.mjs pin. Order matches the
// REQUIRED_ENV_VARS order contract from src/storage/OssStorage.mjs.
const REQUIRED_VARS = [
	"MERMAID_OSS_ENDPOINT",
	"MERMAID_OSS_REGION",
	"MERMAID_OSS_ACCESS_KEY_ID",
	"MERMAID_OSS_SECRET_ACCESS_KEY",
	"MERMAID_OSS_BUCKET",
];

// Names S02 ships over stdio MCP. The 7-tool shape is locked in
// tests/integration/stdio-mcp.test.mjs; this test re-checks the same
// shape under the degraded-boot path because the boot catch block
// replaces the storage instance (plain LocalFsStorage) but the
// `registerTools` wiring is unchanged — the wrapper still enumerates
// the same 7 tools.
const EXPECTED_TOOL_NAMES_SORTED = [
	"delete_mermaid",
	"get_diagram",
	"list_diagrams",
	"pin_mermaid",
	"render_mermaid",
	"search_diagrams",
	"unpin_mermaid",
];

/** Pick a free port on 127.0.0.1 to avoid colliding with other local
 *  processes or parallel test runs. Mirrors the helper used in
 *  tests/integration/http.test.mjs. */
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

/** Poll /health on the given port until it returns 200 (or timeout).
 *  Reaching the endpoint proves the boot completed AND the HTTP
 *  listener is up — both must hold even in the degraded-boot path. */
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

/** Pull structured JSON log lines out of the captured stderr stream.
 *  The logger writes one JSON object per line, so we split on '\n',
 *  filter lines starting with '{', and JSON.parse each one. Mirrors
 *  parseStderrEvents in tests/integration/oss-backend-boot.test.mjs
 *  verbatim (copying the 8-line helper is cheaper than refactoring
 *  it across the two test files). */
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

describe("OSS env-missing boot degradation (S03 fix)", () => {
	let dataDir;
	let port;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-oss-env-degraded-"));
		port = await getFreePort();
		// Spawn the server in HTTP mode (so we can hit /health) with the
		// degraded env: backend=oss + every required var set to "" so
		// the factory's missing-var check fires deterministically
		// regardless of the parent shell's MERMAID_OSS_* exports. The
		// factory treats empty strings the same as missing (see
		// src/storage/OssStorage.mjs:OssStorageFromEnv).
		server = spawnServer({
			env: {
				MERMAID_RENDERER_DATA: dataDir,
				MERMAID_RENDERER_HTTP: "1",
				MERMAID_RENDERER_PORT: String(port),
				MERMAID_RENDERER_HOST: "127.0.0.1",
				MERMAID_RENDERER_BACKEND: "oss",
				MERMAID_OSS_ENDPOINT: "",
				MERMAID_OSS_REGION: "",
				MERMAID_OSS_ACCESS_KEY_ID: "",
				MERMAID_OSS_SECRET_ACCESS_KEY: "",
				MERMAID_OSS_BUCKET: "",
			},
		});
	});

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// close() rejects in-flight sends on shutdown; safe to
				// ignore in cleanup. The test that needs stderr and
				// exit code captures them before letting afterEach
				// run.
			}
		}
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("boots in degraded mode: stderr logs + /health backend='degraded' + stdio render_mermaid returns valid ASCII + counters.json persists oss_init_degraded_count=1", async () => {
		// (A) /health must answer — the boot finished (graceful fallback)
		//     and the HTTP listener is up. Without this, none of the
		//     /health assertions below can be checked.
		await waitForHealth(port);

		// (B) /health surface: top-level backend/last_oss_failure/
		//     boot_degraded + counters.oss_init_degraded_count +
		//     counters.breaker_trips_count. Backed by the in-memory
		//     health-state module + the boot-time counter increment
		//     in src/server.mjs.
		const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
		expect(healthRes.status).toBe(200);
		const health = await healthRes.json();

		expect(health.status).toBe("ok");
		// T04 /health extension — top-level backend resolves to
		// "degraded" because hs.boot_degraded === true (the boot
		// catch path took the OssEnvInvalidError branch).
		expect(health.backend).toBe("degraded");
		expect(health.boot_degraded).toBe(true);
		// The recorded OSS failure carries the env-missing shape:
		//   { ts: <epoch ms>, code: -32006, msg: <error text including
		//   the missing var names> }
		expect(health.last_oss_failure).not.toBeNull();
		expect(health.last_oss_failure.code).toBe(-32006);
		expect(typeof health.last_oss_failure.ts).toBe("number");
		expect(health.last_oss_failure.ts).toBeGreaterThan(0);
		expect(typeof health.last_oss_failure.msg).toBe("string");
		expect(health.last_oss_failure.msg.length).toBeGreaterThan(0);
		// The msg mirrors OssEnvInvalidError's super("OssStorage env
		// invalid; missing required vars: <comma list>") — the
		// factory's super(msg) is passed verbatim by setBootOssFailure
		// (see src/server.mjs boot catch). The presence of any one
		// required var name in msg is enough to lock the contract.
		expect(health.last_oss_failure.msg).toMatch(/MERMAID_OSS_BUCKET/);

		// (C) Persistent counter: the boot path increments
		// oss_init_degraded_count in <dataDir>/counters.json. The
		// same counter is also exposed via /health.counters, but
		// reading the on-disk file is the persistence proof (it
		// survives process exit, unlike the in-memory
		// health-state.boot_degraded flag).
		expect(health.counters).toBeDefined();
		expect(health.counters.oss_init_degraded_count).toBe(1);
		// breaker_trips_count stays 0 — the breaker never tripped
		// because boot fell back BEFORE any primary OSS call could
		// fail. A value > 0 here would mean the degraded path is
		// leaking into runtime metrics, which would confuse the
		// "OSS is the configured backend but never used" signal.
		expect(health.counters.breaker_trips_count).toBe(0);
		// Other counters stay at their seeded 0 (or whatever the
		// load-time sweep bumped sweep_runs to — the load() sweep
		// runs synchronously at boot, so sweep_runs >= 1).
		expect(health.counters.render_total).toBe(0);
		expect(health.counters.render_errors).toBe(0);
		expect(health.counters.sweep_runs).toBeGreaterThanOrEqual(1);
		expect(health.counters.sweep_removed).toBe(0);

		// (D) The /health storage sub-block is OMITTED in the
		// degraded-boot path. The boot catch replaces the storage
		// with a plain LocalFsStorage (no .health() method), so
		// server.mjs's `typeof storage.health === "function"`
		// check is false and the response does not include
		// `storage`. The top-level `backend: "degraded"` and
		// `last_oss_failure` fields give the operator the same
		// observability surface.
		expect(health.storage).toBeUndefined();

		// (E) The stdio MCP path still answers (D017: optional
		// integration failure must not block the main flow). The
		// boot-degraded path keeps the SAME McpServer instance
		// running — only the storage instance is swapped, and the
		// `registerTools` wrapper was already wired before the
		// catch block ran, so 7 tools are still exposed.
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});

		const listResult = await server.send("tools/list", {});
		expect(listResult).toBeDefined();
		expect(Array.isArray(listResult.tools)).toBe(true);
		expect(listResult.tools.length).toBe(7);
		expect(listResult.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES_SORTED);

		// (F) render_mermaid returns the R020 success envelope with
		// non-empty ASCII (the LocalFsStorage fallback in the boot
		// catch path stores the render correctly). The ASCII must
		// NOT start with the [mermaid-ascii failed: ...] sentinel
		// — that prefix would mean the ASCII conversion crashed
		// even with the fallback storage.
		const callResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});
		expect(callResult).toBeDefined();
		expect(callResult.isError).toBeFalsy();
		expect(Array.isArray(callResult.content)).toBe(true);
		expect(callResult.content.length).toBeGreaterThan(0);
		expect(callResult.content[0].type).toBe("text");
		const body = JSON.parse(callResult.content[0].text);
		expect(typeof body.id).toBe("string");
		expect(body.id.length).toBeGreaterThan(0);
		expect(typeof body.ascii).toBe("string");
		expect(body.ascii.length).toBeGreaterThan(0);
		// The fallback storage wrote a blob under <dataDir>/blobs/<id>.html
		// so fileLink is reachable (file:// scheme).
		expect(typeof body.fileLink).toBe("string");
		expect(body.fileLink.startsWith("file:///")).toBe(true);
		// Best-effort ASCII conversion must not have crashed — the
		// fallback to LocalFsStorage should give a real mermaid
		// render the same as a clean local boot.
		expect(body.ascii.startsWith("[mermaid-ascii failed:")).toBe(false);
		// No warnings in the success envelope (the renderer's
		// R025 best-effort ASCII path produced a real result, not
		// the failure sentinel).
		expect(body.warnings ?? []).toEqual([]);

		// (G) Now that the stdio call is observed to succeed, /health's
		// render_total counter should reflect the 1 successful call.
		// Re-fetching /health is a separate fetch — proves the
		// counter increment is observable through the same surface
		// the operator uses.
		const healthRes2 = await fetch(`http://127.0.0.1:${port}/health`);
		expect(healthRes2.status).toBe(200);
		const health2 = await healthRes2.json();
		expect(health2.counters.render_total).toBe(1);
		// And the top-level backend/last_oss_failure fields are
		// STABLE across tool calls — the boot record is set once,
		// not overwritten by runtime events.
		expect(health2.backend).toBe("degraded");
		expect(health2.last_oss_failure.code).toBe(-32006);
	});

	it("emits the structured stderr events (oss_env_invalid + oss_init_degraded warn/code=-32006/fallback='local'/missing=[5 vars]) and persists oss_init_degraded_count to data/counters.json", async () => {
		// The structured stderr events fire AT BOOT — they are
		// independent of any /health fetch or stdio call. Wait for
		// /health just to make sure the boot fully settled, then
		// close the child so we can inspect stderr + the on-disk
		// counters file.
		await waitForHealth(port);

		// (A) Drive one stdio call before close, so the boot
		// events are clearly separated from any later tool-call
		// events in the stderr stream.
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});

		// Close the child so the assertions on stderr and on-disk
		// counters file are post-shutdown. The helper's close()
		// resolves with { stdout, stderr, code } and the boot
		// path's exit is natural (stdio closed → no listeners →
		// process exits with code 0; the hourly sweep setInterval
		// is .unref'd so it doesn't keep the loop alive).
		const closed = await server.close();
		server = null; // tell afterEach to skip the second close
		const stderr = closed?.stderr || "";
		expect(typeof stderr).toBe("string");

		// (B) Stderr must contain the new warn-level event name and
		// the factory's pre-throw log line.
		expect(stderr).toContain("oss_init_degraded");
		expect(stderr).toContain("oss_env_invalid");

		// (C) The OLD event names must NOT appear. A regression that
		// re-introduces the M002-era D018 name or the pre-T01
		// fatal-exit name would fail here. The substring check is
		// intentionally narrow to avoid matching the new event
		// name's prefix.
		expect(stderr).not.toContain("oss_init_failed_fallback");
		expect(stderr).not.toContain('"event":"oss_init_failed"');

		// (D) Parse the stderr stream and assert the structured
		// shape of `oss_init_degraded`:
		//   { level: "warn", event: "oss_init_degraded",
		//     code: -32006, missing: [...5 vars], fallback: "local",
		//     ts: <iso>, hint: "..." }
		const events = parseStderrEvents(stderr);
		const degraded = events.find((e) => e.event === "oss_init_degraded");
		expect(degraded).toBeTruthy();
		expect(degraded.level).toBe("warn");
		expect(degraded.code).toBe(-32006);
		expect(degraded.fallback).toBe("local");
		expect(Array.isArray(degraded.missing)).toBe(true);
		expect(degraded.missing).toEqual(expect.arrayContaining(REQUIRED_VARS));
		expect(degraded.missing).toHaveLength(REQUIRED_VARS.length);

		// (E) The factory's pre-throw log must also have a parseable
		// shape: level=error, event=oss_env_invalid, missing=[...].
		// (No `code` here — the factory's log is a configuration-
		// error marker, not a JSON-RPC code, so the field is
		// deliberately absent.)
		const envInvalid = events.find((e) => e.event === "oss_env_invalid");
		expect(envInvalid).toBeTruthy();
		expect(envInvalid.level).toBe("error");
		expect(Array.isArray(envInvalid.missing)).toBe(true);
		expect(envInvalid.missing).toEqual(expect.arrayContaining(REQUIRED_VARS));

		// (F) All 5 required var names appear in the stderr stream
		// at least once (covered by both the factory and the boot
		// catch block). Grep-style for human-readability:
		for (const v of REQUIRED_VARS) {
			expect(stderr).toContain(v);
		}

		// (G) The counters file is the persistence proof. The
		// in-memory /health.counters value is one signal; reading
		// the on-disk file proves the bump hit disk and would
		// survive a restart. The Counters class writes via
		// tmp+rename so the file is atomic.
		const countersRaw = await readFile(join(dataDir, "counters.json"), "utf-8");
		const counters = JSON.parse(countersRaw);
		expect(counters.oss_init_degraded_count).toBe(1);
		// All other M003 counter keys are present (seeded on load
		// to 0, so a missing key here would mean the file was
		// not the freshly-seeded one).
		for (const k of [
			"render_total",
			"render_errors",
			"ascii_failures",
			"storage_write_retries",
			"sweep_runs",
			"sweep_removed",
			"breaker_trips_count",
		]) {
			expect(counters).toHaveProperty(k);
		}
		// After the one stdio render_mermaid call, render_total
		// must be 1. This is the cross-check that the stdio call
		// in (A) did increment the counter (so the on-disk file
		// reflects the runtime state, not just the boot-time
		// oss_init_degraded_count).
		expect(counters.render_total).toBe(1);
		// breaker_trips_count is still 0 (the breaker never
		// tripped — boot fell back before any primary call).
		expect(counters.breaker_trips_count).toBe(0);

		// (H) Lock the "boot did not hard-exit" property indirectly:
		// the test reached this point (waitForHealth + stdio call +
		// on-disk counter read all succeeded) only if the server
		// kept running through the boot-degraded path. We do NOT
		// assert closed.code === 0 here because the project
		// helper's close() escalates to SIGKILL when the process
		// doesn't exit naturally within 1.2s — that's by design
		// to keep the test harness from hanging, and the SIGKILL'd
		// exit code is reported as null (the 'exit' event fires
		// with `code = null, signal = 'SIGKILL'`). The "no
		// hard-exit on env error" property is locked separately
		// by the existing tests/integration/oss-backend-boot.test.mjs
		// (which uses a child-spawn helper without the SIGKILL
		// escalation and asserts code === 0). For HTTP-mode use
		// of the project helper, the proof is "waitForHealth
		// resolved" + "the stdio call returned a result" + "the
		// counters file got written" — all three are already
		// asserted above.
	});
});
