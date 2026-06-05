// tests/helpers/server.mjs — spawn the mermaid-renderer MCP server in a child
// process and drive it via JSON-RPC over stdio.
//
// Reuses the driver pattern from scripts/smoke.sh (the heredoc Node block
// that calls initialize / tools/list / tools/call). It is intentionally
// re-implemented in JS rather than imported from smoke.sh, so test code
// does not depend on bash. stdout is parsed as NDJSON (one JSON-RPC message
// per line). stderr is captured and surfaced on close for diagnostics.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "..", "src", "server.mjs");

/**
 * Spawn the mermaid-renderer server as a child process.
 *
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.env]   extra env vars merged into process.env
 * @param {string[]} [opts.args]               extra args appended to `node src/server.mjs`
 * @returns {{
 *   child: import("node:child_process").ChildProcess,
 *   send: (method: string, params?: unknown) => Promise<unknown>,
 *   close: () => Promise<{ stdout: string, stderr: string, code: number | null }>
 * }}
 */
export function spawnServer({ env = {}, args = [] } = {}) {
	const child = spawn("node", [SERVER_PATH, ...args], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	let buffer = "";
	let id = 0;
	const pending = new Map();
	const stderrChunks = [];

	child.stderr.on("data", (chunk) => {
		stderrChunks.push(chunk.toString("utf-8"));
	});

	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf-8");
		let idx;
		while ((idx = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				// ignore non-JSON lines (the server does not emit any today)
				continue;
			}
			if (msg && msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});

	child.on("error", (err) => {
		// surface spawn errors to any outstanding waiters so tests don't hang
		for (const reject of pending.values()) reject(err);
		pending.clear();
	});

	function send(method, params) {
		const _id = ++id;
		return new Promise((resolve, reject) => {
			pending.set(_id, (msg) => {
				if (msg.error) reject(Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), { rpcError: msg.error }));
				else resolve(msg.result);
			});
			const payload = JSON.stringify({ jsonrpc: "2.0", id: _id, method, params: params ?? {} });
			child.stdin.write(payload + "\n", (err) => {
				if (err) {
					pending.delete(_id);
					reject(err);
				}
			});
		});
	}

	function close() {
		return new Promise((resolveClose) => {
			// reject any in-flight send() so callers can clean up
			const drainErr = new Error("server closed");
			for (const reject of pending.values()) reject(drainErr);
			pending.clear();
			child.stdin.end();

			let resolved = false;
			const done = (code) => {
				if (resolved) return;
				resolved = true;
				resolveClose({
					stdout: buffer,
					stderr: stderrChunks.join(""),
					code,
				});
			};
			// The server may have already exited by the time close() runs —
			// e.g. a boot-time process.exit(1) on invalid env (M002/S01/T03),
			// or any fast-fail path. The 'exit' event fires once at process
			// death; listeners added after the fact are never invoked. Check
			// child.exitCode / child.signalCode up front so the test harness
			// sees the real termination code (not a SIGKILL fallback from the
			// timer below). When the child is still alive, fall through to
			// the 'exit' listener + signal escalation.
			if (child.exitCode != null || child.signalCode != null) {
				return done(child.exitCode);
			}
			child.on("exit", (code) => done(code));

			// Graceful: end stdin + give the server a moment to flush + exit.
			// The server registers a 1h `setInterval` for the sweep that is
			// NOT unref'd, so the event loop never goes idle on its own.
			// Escalate SIGTERM -> SIGKILL to avoid hanging the test on
			// non-Windows runners where the SIGTERM handler's 3s unref'd
			// drain timer can't overcome the live setInterval.
			setTimeout(() => {
				if (child.exitCode == null && !child.killed) child.kill("SIGTERM");
			}, 150).unref();
			setTimeout(() => {
				if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
			}, 1200).unref();
		});
	}

	return { child, send, close };
}

export { SERVER_PATH };
