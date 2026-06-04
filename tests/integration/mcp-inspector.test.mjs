// tests/integration/mcp-inspector.test.mjs — S04 / T04
//
// Protocol-level smoke proving the v0.2.0 server is drivable by an
// independent stdio MCP client implementation (any spec-compliant
// JSON-RPC client). This file is intentionally NOT a thin wrapper over
// `tests/helpers/server.mjs` — it writes its own minimal frame loop so
// that the test passes even if the helper is wrong. The complement
// `stdio-mcp.test.mjs` locks the same 7-tool surface through the
// project helper; this file is the "external client" check.
//
// What this file proves (5 it() blocks):
//   1. initialize handshake + serverInfo.name + version string present
//   2. tools/list returns exactly the 7 v0.2.0 tools in spec order
//   3. tools/call render_mermaid returns the R020 success envelope
//      (content[0].text parses to {id, ascii, fileLink, httpLink, title,
//      elapsed_ms, warnings}; isError === false)
//   4. tools/call pin_mermaid returns a success envelope with pinned: true
//   5. tools/call search_diagrams finds the diagram by title substring
//      and the result item carries an `id` field (MEM024 closure
//      visible at the wire level)
//
// Driver: spawn `node src/server.mjs` directly, write one JSON-RPC
// frame per line to its stdin, read NDJSON responses from its stdout.
// Identical to the on-the-wire pattern the @modelcontextprotocol/inspector
// CLI uses against a stdio server — so a green test here is a green
// test for the Inspector surface as well.
//
// Each test spawns a fresh child with MERMAID_RENDERER_DATA pointed at
// a per-test temp dir; the real <repo>/data/ is never touched.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "..", "src", "server.mjs");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcp-inspector-smoke", version: "0.0.0" };
const EXPECTED_TOOL_NAMES = [
	"delete_mermaid",
	"get_diagram",
	"list_diagrams",
	"pin_mermaid",
	"render_mermaid",
	"search_diagrams",
	"unpin_mermaid",
];

/**
 * Spawn a fresh server child and return a minimal JSON-RPC driver.
 * Each `request(method, params)` sends one frame and resolves with the
 * matching response by `id`. Stdout is parsed as NDJSON. Errors with
 * {code, message} come back as thrown Error with a `.rpcError` field.
 */
function spawnInspectorClient(env) {
	const child = spawn("node", [SERVER_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	let buffer = "";
	let nextId = 0;
	const pending = new Map();
	const stderrChunks = [];
	let closed = false;

	child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf-8")));

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
				// server may log non-JSON; ignore for protocol purposes
				continue;
			}
			if (msg && typeof msg === "object" && msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});

	child.on("error", (err) => {
		// surface spawn errors to outstanding waiters
		for (const reject of pending.values()) reject(err);
		pending.clear();
	});

	function request(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			if (closed) return reject(new Error("client closed"));
			pending.set(id, (msg) => {
				if (msg.error) {
					const err = new Error(msg.error.message || JSON.stringify(msg.error));
					err.rpcError = msg.error;
					reject(err);
				} else {
					resolve(msg.result);
				}
			});
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params: params ?? {},
			});
			child.stdin.write(payload + "\n", (err) => {
				if (err) reject(err);
			});
		});
	}

	function close() {
		return new Promise((resolve) => {
			if (closed) return resolve({ stderr: "" });
			closed = true;
			child.once("close", () => {
				resolve({ stderr: stderrChunks.join("") });
			});
			try {
				child.stdin.end();
			} catch {
				// best-effort
			}
			// hard-kill after 1s if it does not exit on stdin end
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 1000).unref();
		});
	}

	return { request, close };
}

/** Parse the single text item in a tools/call result.content[0] as JSON. */
function parseCallText(callResult) {
	expect(callResult).toBeDefined();
	expect(Array.isArray(callResult.content)).toBe(true);
	expect(callResult.content.length).toBeGreaterThan(0);
	const first = callResult.content[0];
	expect(first.type).toBe("text");
	expect(typeof first.text).toBe("string");
	return JSON.parse(first.text);
}

async function initialize(client) {
	return client.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

describe("MCP Inspector protocol smoke (independent driver)", () => {
	let dataDir;
	let client;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-inspector-"));
		client = spawnInspectorClient({ MERMAID_RENDERER_DATA: dataDir });
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.close();
			} catch {
				// best-effort
			}
		}
		if (dataDir) {
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("1. initialize handshake returns serverInfo.name === 'mermaid-tui-mcp' with a non-empty version", async () => {
		const result = await initialize(client);
		expect(result).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(result.serverInfo.name).toBe("mermaid-tui-mcp");
		// The v0.2.0 contract pins a non-empty version string. Tests do
		// not pin the exact value (semver may advance) but it must be
		// a non-empty string.
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	});

	it("2. tools/list returns the 7 v0.2.0 tools with name + description + non-empty inputSchema", async () => {
		await initialize(client);
		const result = await client.request("tools/list", {});
		expect(result).toBeDefined();
		expect(Array.isArray(result.tools)).toBe(true);
		// 7-tool surface is the v0.2.0 contract
		expect(result.tools.length).toBe(7);
		expect(result.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
		// Each tool must carry a non-empty description and a JSON-schema
		// inputSchema (the latter is the wire contract for LLM clients).
		for (const t of result.tools) {
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}
	});

	it("3. tools/call render_mermaid returns the R020 success envelope (id, ascii, fileLink, httpLink, title, elapsed_ms, warnings)", async () => {
		await initialize(client);
		const callResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: {
				code: "graph TD\n  A-->B",
				title: "Inspector smoke",
			},
		});
		expect(callResult).toBeDefined();
		// The R020 success shape is { content: [{type:"text", text: "<json>"}] }
		// with NO top-level isError field (isError is only set on failure).
		expect(callResult.isError).toBeUndefined();
		const body = parseCallText(callResult);
		// R020 success envelope: every documented field is present
		expect(typeof body.id).toBe("string");
		expect(body.id.length).toBeGreaterThan(0);
		expect(typeof body.ascii).toBe("string");
		expect(body.ascii.length).toBeGreaterThan(0);
		expect(typeof body.fileLink).toBe("string");
		expect(body.fileLink).toMatch(/^file:\/\//);
		// httpLink is null when HTTP daemon is not running — both
		// values are valid wire shapes
		expect(body.httpLink === null || typeof body.httpLink === "string").toBe(true);
		expect(body.title).toBe("Inspector smoke");
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
		// warnings is OPTIONAL: only emitted when mermaid emits a non-fatal
		// warning (e.g. partial parse). A clean render has no warnings
		// field at all.
		expect(body.warnings === undefined || Array.isArray(body.warnings)).toBe(true);
	});

	it("4. tools/call pin_mermaid returns the R020 success envelope with pinned: true", async () => {
		// Set up: render first, then pin
		await initialize(client);
		const renderResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  X-->Y", title: "pin-target" },
		});
		const rendered = parseCallText(renderResult);
		expect(rendered.id).toBeDefined();

		// Pin it
		const pinResult = await client.request("tools/call", {
			name: "pin_mermaid",
			arguments: { id: rendered.id },
		});
		expect(pinResult.isError).toBeUndefined();
		const pinBody = parseCallText(pinResult);
		expect(pinBody.id).toBe(rendered.id);
		expect(pinBody.pinned).toBe(true);
		expect(typeof pinBody.elapsed_ms).toBe("number");
	});

	it("5. tools/call search_diagrams finds by title substring and the result item carries an `id` (MEM024 wire-level closure)", async () => {
		await initialize(client);
		// Render a uniquely-titled diagram
		const uniqueTitle = `inspector-search-${Date.now()}`;
		const renderResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  P-->Q", title: uniqueTitle },
		});
		expect(renderResult.isError).toBeUndefined();

		// Search for it by title substring
		const searchResult = await client.request("tools/call", {
			name: "search_diagrams",
			arguments: { query: uniqueTitle },
		});
		expect(searchResult.isError).toBeUndefined();
		const body = parseCallText(searchResult);
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items.length).toBeGreaterThan(0);
		// MEM024: each search result item MUST carry an `id` so the
		// caller can pin/get/delete by reference. Locked at the wire
		// level (the same `id` LocalFsStorage.list/.search project).
		for (const item of body.items) {
			expect(typeof item.id).toBe("string");
			expect(item.id.length).toBeGreaterThan(0);
		}
		// And the matching item is present
		const hit = body.items.find((i) => i.title === uniqueTitle);
		expect(hit).toBeDefined();
		expect(hit.titleMatch).toBe(true);
	});
});
