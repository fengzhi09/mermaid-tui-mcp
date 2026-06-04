// tests/integration/http.test.mjs — drives the real server in HTTP standalone
// mode (MERMAID_RENDERER_HTTP=1) and exercises the four routes that
// bin/start.sh exposes: GET /health, GET /raw/svg, POST /pin, GET /view.
//
// Each test picks a free port via net.createServer.listen(0), spawns the
// server with that port + a per-test temp data dir, waits for /health to
// answer (which also proves the HTTP listener is up and the storage is
// initialised), then seeds a render via the stdio MCP path and hits the
// remaining routes. Using a free port avoids collisions with other local
// processes and with parallel test runs; the per-test data dir keeps the
// real <repo>/data/ untouched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as netCreateServer } from "node:net";

import { spawnServer } from "../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const HEALTH_TIMEOUT_MS = 5000;

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

describe("HTTP integration", () => {
	let dataDir;
	let port;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-int-http-"));
		port = await getFreePort();
		server = spawnServer({
			env: {
				MERMAID_RENDERER_DATA: dataDir,
				MERMAID_RENDERER_HTTP: "1",
				MERMAID_RENDERER_PORT: String(port),
				MERMAID_RENDERER_HOST: "127.0.0.1",
			},
		});
	});

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// close() rejects in-flight sends on shutdown; safe to ignore in cleanup
			}
		}
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("serves /health, /raw/svg, /pin, and /view for a freshly rendered diagram", async () => {
		// confirm HTTP listener is up before we start driving it
		await waitForHealth(port);

		// seed a render over the stdio MCP path (same child process, MCP transport)
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});
		const callResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});
		const seeded = JSON.parse(callResult.content[0].text);
		const id = seeded.id;
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);

		// 1. GET /health — must reflect the seeded render (total >= 1)
		const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
		expect(healthRes.status).toBe(200);
		const health = await healthRes.json();
		expect(health.status).toBe("ok");
		expect(typeof health.version).toBe("string");
		expect(health.version.length).toBeGreaterThan(0);
		expect(health.total).toBeGreaterThanOrEqual(1);

		// 2. GET /raw/svg?id=<id> — must return the raw SVG body
		const svgRes = await fetch(`http://127.0.0.1:${port}/raw/svg?id=${id}`);
		expect(svgRes.status).toBe(200);
		expect(svgRes.headers.get("content-type") || "").toContain("image/svg+xml");
		const svgBody = await svgRes.text();
		expect(svgBody).toMatch(/<svg/);

		// 3. POST /pin?id=<id>&pin=true — must flip the pinned flag
		const pinRes = await fetch(`http://127.0.0.1:${port}/pin?id=${id}&pin=true`, { method: "POST" });
		expect(pinRes.status).toBe(200);
		const pinBody = await pinRes.json();
		expect(pinBody.pinned).toBe(true);
		expect(pinBody.id).toBe(id);

		// 4. GET /view?id=<id> — must return an HTML page that contains the id
		const viewRes = await fetch(`http://127.0.0.1:${port}/view?id=${id}`);
		expect(viewRes.status).toBe(200);
		expect(viewRes.headers.get("content-type") || "").toContain("text/html");
		const html = await viewRes.text();
		expect(html).toContain(id);
	});
});
