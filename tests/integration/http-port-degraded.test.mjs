// tests/integration/http-port-degraded.test.mjs — D017 graceful-degradation
// path when all three candidate HTTP ports are already in use.
//
// Locks the behavior shipped in M003 S03: when MERMAID_RENDERER_HTTP=1 and
// the server cannot bind to <HTTP_PORT> → <HTTP_PORT+1> → <HTTP_PORT+2>
// (all EADDRINUSE), it must
//
//   1. NOT exit the process (hard-exit would be a regression — D017 says
//      "optional integration failure does not block the main flow").
//   2. Emit a structured `http_listen_failed_fallback` warn-level log
//      with `fallback: "stdio-only"` and `ports_tried: [HTTP_PORT,
//      HTTP_PORT+1, HTTP_PORT+2]` so operators can grep for the
//      condition.
//   3. Continue serving the stdio MCP surface: `tools/list` returns 7
//      tools, `render_mermaid` returns a non-empty ASCII diagram.
//
// This test does NOT assert ECONNREFUSED against 127.0.0.1:HTTP_PORT with
// a fresh `fetch()` — the port-blockers we install with `net.createServer`
// would themselves accept the connection and hang. The structured
// `http_listen_failed_fallback` log is the durable signal that the HTTP
// listener was never bound (proven by the catch-block setting
// `httpEnabled = false`). A future test that wants to assert "HTTP is
// off" at the socket level should close the blockers first, then probe —
// but that's orthogonal to what this test locks.
//
// Test shape: pick a free base port (avoiding 5300/5301/5302 which a
// developer's running daemon may already hold), block [base, base+1,
// base+2] with three `net.createServer()` listeners bound to 127.0.0.1;
// spawn one mermaid-renderer child with MERMAID_RENDERER_HTTP=1 +
// MERMAID_RENDERER_PORT=<base> + a per-test temp data dir; exercise
// stdio MCP; close; parse stderr as NDJSON and assert the warn event.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer } from "node:net";

import { spawnServer } from "../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const VALID_GRAPH = "graph TD\n  A-->B";

/**
 * Parse the server's stderr as NDJSON. The structured logger in
 * src/logger.mjs emits one JSON object per line; non-JSON lines are
 * silently dropped (defensive — the server should never emit any, but a
 * stray warn from a transitive dep would not break the test).
 *
 * @param {string} stderr
 * @returns {Array<Record<string, unknown>>}
 */
function parseNdjson(stderr) {
	return stderr
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((x) => x !== null);
}

/**
 * Get one free port from the OS by binding on 0, reading the assigned
 * port, then closing. Mirrors the pattern in tests/integration/http.test.mjs
 * so the test is robust against the developer's machine already running
 * another daemon on 5300/5301/5302 — the M003 mermaid server tries
 * `[HTTP_PORT, HTTP_PORT+1, HTTP_PORT+2]`, so we pick a free base port
 * and block that + the next two.
 *
 * @returns {Promise<number>}
 */
function getFreePort() {
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

/**
 * Bind a TCP listener to 127.0.0.1:<port> that just accepts connections
 * and never writes a response — enough to make the OS report the port as
 * EADDRINUSE to any other process that tries to bind it.
 *
 * @param {number} port
 * @returns {Promise<import("node:net").Server>}
 */
function bindBlocker(port) {
	return new Promise((resolve, reject) => {
		const srv = netCreateServer();
		srv.on("error", reject);
		srv.listen(port, "127.0.0.1", () => resolve(srv));
	});
}

describe("HTTP port-degraded (D017 stdio-only fallback)", () => {
	/** @type {Array<import("node:net").Server>} */
	let blockers = [];
	/** @type {number | undefined} */
	let basePort;
	/** @type {string | undefined} */
	let dataDir;
	/** @type {ReturnType<typeof spawnServer> | undefined} */
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-int-port-degraded-"));
		// Pick a free base port, then block [base, base+1, base+2] with
		// three real listeners. The mermaid server's tryListen will
		// EADDRINUSE on all three and fall back to stdio-only per D017.
		// We cannot hardcode 5300/5301/5302 — a developer's running
		// daemon (or a parallel start.sh) may already hold them.
		basePort = await getFreePort();
		blockers = await Promise.all(
			[basePort, basePort + 1, basePort + 2].map(bindBlocker),
		);
	});

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// close() rejects in-flight sends on shutdown; safe to ignore in cleanup
			}
		}
		// Close blockers in parallel — they each accept a `close(cb)` and
		// never received a connection in this test, so close() is instant.
		await Promise.all(
			blockers.map(
				(b) =>
					new Promise((resolve) => {
						try {
							b.close(() => resolve());
						} catch {
							resolve();
						}
					}),
			),
		);
		blockers = [];
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("falls back to stdio-only when all 3 candidate HTTP ports are in use", async () => {
		server = spawnServer({
			env: {
				MERMAID_RENDERER_DATA: dataDir,
				MERMAID_RENDERER_HTTP: "1",
				MERMAID_RENDERER_PORT: String(basePort),
				MERMAID_RENDERER_HOST: "127.0.0.1",
			},
		});

		// (1) stdio readiness — the MCP transport is connected before
		// tryListen runs (see server.mjs: mcp.connect() is awaited
		// before the if (httpEnabled) block). Sending `initialize`
		// proves the stdio path is live; if the server had hard-exited
		// on a port-taken precondition, this send would reject.
		const initResult = await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		expect(initResult).toBeDefined();
		expect(initResult.serverInfo).toBeDefined();
		expect(initResult.serverInfo.name).toBe("mermaid-tui-mcp");

		// (2) stdio MCP still works — the 7-tool surface (S02 contract)
		// must be intact even when HTTP is degraded.
		const toolsList = await server.send("tools/list", {});
		expect(Array.isArray(toolsList.tools)).toBe(true);
		expect(toolsList.tools.length).toBe(7);

		// (3) render_mermaid still produces a real diagram — proves
		// the storage + renderer + ASCII pipeline is unaffected by
		// the HTTP-listener failure.
		const callResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH },
		});
		expect(callResult.isError).toBeFalsy();
		expect(Array.isArray(callResult.content)).toBe(true);
		expect(callResult.content.length).toBeGreaterThan(0);
		const parsed = JSON.parse(callResult.content[0].text);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);

		// (4) Close stdio and inspect the boot-time stderr. The
		// structured `http_listen_failed_fallback` event is the
		// durable signal that the HTTP listener was never bound —
		// equivalent to a "no /health, no /view" assertion at the
		// log level. The mermaid server emits this event AFTER
		// mcp.connect() (so after the stdio transport is up) and
		// AFTER trying all 3 ports (~100ms of unref'd sleeps in
		// src/port-fallback.mjs). By the time close() resolves, the
		// process has exited naturally (all handles unref'd) or via
		// the SIGTERM handler's process.exit(0).
		const { stderr, code } = await server.close();
		// The child must NOT have hard-exited with a non-zero code
		// (that would be the D017 regression we're guarding against).
		// 0 = clean exit; null = killed by signal (helper's SIGKILL
		// escalation). Either is "didn't crash on port-taken".
		expect([0, null]).toContain(code);

		const events = parseNdjson(stderr);
		const fallbackEvent = events.find((e) => e.event === "http_listen_failed_fallback");
		expect(fallbackEvent).toBeDefined();
		expect(fallbackEvent.level).toBe("warn");
		expect(fallbackEvent.fallback).toBe("stdio-only");
		expect(fallbackEvent.ports_tried).toEqual([basePort, basePort + 1, basePort + 2]);
		// The error string comes from PortInUseError whose message is
		// "all candidate ports in use: 5300, 5301, 5302" — assert a
		// substring that pins the shape without coupling to the exact
		// wording (the message is informational, the structured fields
		// above are the contract).
		expect(typeof fallbackEvent.error).toBe("string");
		expect(fallbackEvent.error).toMatch(/ports in use/);
		// `hint` is the operator-facing one-liner — assert it exists
		// (and references stdio) so the grep story stays intact.
		expect(typeof fallbackEvent.hint).toBe("string");
		expect(fallbackEvent.hint).toMatch(/stdio/i);
	});
});
