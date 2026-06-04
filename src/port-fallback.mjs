// src/port-fallback.mjs — HTTP port-fallback helper for the standalone view
// daemon (R016).
//
// The standalone HTTP listener (MERMAID_RENDERER_HTTP=1) tries to bind to
// 127.0.0.1:5300 by default. If 5300 is already in use (a previous server
// instance, a developer running an unrelated tool, or a parallel test
// run), we want to fall back to 5301 then 5302 transparently — the
// caller (server.mjs) only sees the port that successfully bound, or a
// tagged PortInUseError if all three are taken.
//
// The 50ms sleep between attempts is small enough to feel instant
// (< 100ms total in the worst case) but long enough to let a
// TIME_WAIT socket finish closing on the previous attempt. setTimeout
// from node:timers/promises returns a promise that is already unref'd
// (it does not keep the event loop alive) — that matches the standalone
// daemon's "exits when no work" lifecycle.

import { setTimeout as unrefSleep } from "node:timers/promises";

import { PortInUseError } from "./errors.mjs";

/**
 * Try to bind `server` to one of `ports` on `host`. On EADDRINUSE (and
 * the port is not the last in the list), try the next port after a
 * 50ms unref'd sleep. On the last port, throw PortInUseError
 * (-32008, retryable: true). On non-EADDRINUSE errors, throw immediately
 * (the listener was never bound).
 *
 * The 50ms gap is intentional: it gives a TIME_WAIT socket time to
 * close, but the cumulative cost in the worst case is 100ms (2 gaps ×
 * 50ms), which is well under the operator-perception threshold.
 *
 * @param {import("node:net").Server} server
 * @param {string} host
 * @param {Array<number>} ports
 * @returns {Promise<number>} the port that successfully bound
 */
export function tryListen(server, host, ports) {
	return (async () => {
		for (let i = 0; i < ports.length; i++) {
			const port = ports[i];
			const isLast = i === ports.length - 1;
			try {
				await listenOnce(server, host, port);
				return port;
			} catch (e) {
				// EADDRINUSE is the retry path; anything else is terminal
				// (EACCES, EAFNOSUPPORT, etc. — bind to a privileged
				// port, or an IPv6 host where the address family is wrong).
				if (!e || e.code !== "EADDRINUSE") {
					throw e;
				}
				if (isLast) {
					throw new PortInUseError(`all candidate ports in use: ${ports.join(", ")}`);
				}
				// Brief backoff so a TIME_WAIT socket has a chance to close.
				await unrefSleep(50);
			}
		}
		// Unreachable: the loop always either returns or throws. Guarded
		// for completeness.
		throw new PortInUseError(`no ports provided to tryListen`);
	})();
}

/**
 * Race server.once('listening', resolve) against server.once('error',
 * reject) for a single bind attempt. The 'listening' and 'error' events
 * are one-shot — once either fires, the other listener is removed so
 * the next attempt doesn't see stale events.
 *
 * @param {import("node:net").Server} server
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
function listenOnce(server, host, port) {
	return new Promise((resolve, reject) => {
		const onListening = () => {
			server.removeListener("error", onError);
			resolve();
		};
		const onError = (e) => {
			server.removeListener("listening", onListening);
			reject(e);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		// server.listen may throw synchronously on a bad argument (e.g. a
		// non-numeric port). Wrap in try/catch and route to the error path.
		try {
			server.listen(port, host);
		} catch (e) {
			server.removeListener("listening", onListening);
			server.removeListener("error", onError);
			reject(e);
		}
	});
}
