// tests/unit/port-fallback.test.mjs — unit tests for src/port-fallback.mjs.
//
// R016 contract: when the standalone HTTP daemon can't bind to the
// primary port (5300), it transparently falls back to 5301 then 5302.
// If all three are taken, the helper throws PortInUseError (-32008,
// retryable: true) so server.mjs can surface the failure to /health
// and stderr.
//
// These tests use real net.Server instances + free-port discovery so
// they exercise the actual listen() / EADDRINUSE code path (not a
// stub). Parallel runs cannot collide because each test grabs its own
// free port + its own short-lived "occupying" server.

import { createServer as netCreateServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { PortInUseError } from "../../src/errors.mjs";
import { tryListen } from "../../src/port-fallback.mjs";

/** Free port discovery — bind 0, read the assigned port, close. */
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

/** Bind a server to a port and keep it open (so the port stays occupied). */
async function occupyPort(port) {
	return new Promise((resolve, reject) => {
		const srv = netCreateServer();
		srv.on("error", reject);
		srv.listen(port, "127.0.0.1", () => resolve(srv));
	});
}

describe("tryListen (R016 — port fallback)", () => {
	/** Servers we opened to keep ports occupied — close in afterEach. */
	const occupants = [];
	/** Servers that tryListen opened for us — close in afterEach. */
	const open = [];

	afterEach(async () => {
		for (const srv of open.splice(0, open.length)) {
			await new Promise((r) => srv.close(() => r()));
		}
		for (const srv of occupants.splice(0, occupants.length)) {
			await new Promise((r) => srv.close(() => r()));
		}
	});

	it("a) first port free: resolves with that port, listener is bound", async () => {
		const port = await getFreePort();
		const target = netCreateServer();
		open.push(target);
		const bound = await tryListen(target, "127.0.0.1", [port]);
		expect(bound).toBe(port);
		// and the server is actually listening on the port
		expect(target.address()).toBeTruthy();
		expect(target.address().port).toBe(port);
	});

	it("b) first port busy, second free: skips EADDRINUSE on the first and binds the second", async () => {
		const occupied = await getFreePort();
		const free = await getFreePort();
		const occ = await occupyPort(occupied);
		occupants.push(occ);

		const target = netCreateServer();
		open.push(target);
		const bound = await tryListen(target, "127.0.0.1", [occupied, free]);
		expect(bound).toBe(free);
		expect(target.address().port).toBe(free);
	});

	it("c) all three ports busy: throws PortInUseError (code -32008, retryable: true)", async () => {
		const a = await getFreePort();
		const b = await getFreePort();
		const c = await getFreePort();
		occupants.push(await occupyPort(a));
		occupants.push(await occupyPort(b));
		occupants.push(await occupyPort(c));

		const target = netCreateServer();
		open.push(target);

		let caught;
		try {
			await tryListen(target, "127.0.0.1", [a, b, c]);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(PortInUseError);
		expect(caught.code).toBe(-32008);
		expect(caught.retryable).toBe(true);
		// The message names all three ports so an operator can see which
		// ones were tried.
		expect(caught.message).toContain(String(a));
		expect(caught.message).toContain(String(b));
		expect(caught.message).toContain(String(c));
		// And the target server is NOT in a listening state — we never bound.
		expect(target.address()).toBeNull();
	});
});
