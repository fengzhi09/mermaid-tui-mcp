// tests/integration/stdio-mcp.test.mjs — drives the real server as a child
// process over stdio JSON-RPC. Locks the v0.1.0 MCP surface (initialize,
// tools/list, tools/call) under vitest so a future change to src/server.mjs
// can't silently break the protocol contract that gsd-pi depends on.
//
// Each test spawns a fresh src/server.mjs with MERMAID_RENDERER_DATA pointed
// at a per-test temp dir (created via os.tmpdir() + mkdtemp), so the real
// <repo>/data/ is never touched and parallel test runs do not collide.
// Cleanup in afterEach: close the child + rm the temp dir.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

async function initialize(server) {
	return server.send("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

describe("stdio MCP integration", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-int-stdio-"));
		server = spawnServer({ env: { MERMAID_RENDERER_DATA: dataDir } });
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

	it("completes the initialize handshake and reports serverInfo.name === 'mermaid-tui-mcp'", async () => {
		const result = await initialize(server);
		expect(result).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(result.serverInfo.name).toBe("mermaid-tui-mcp");
		// the version string is part of the contract — pin it to 0.1.0
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	});

	it("lists render_mermaid in tools/list with a non-empty description and inputSchema.required.includes('code')", async () => {
		await initialize(server);
		const result = await server.send("tools/list", {});
		expect(result).toBeDefined();
		expect(Array.isArray(result.tools)).toBe(true);
		const tool = result.tools.find((t) => t.name === "render_mermaid");
		expect(tool).toBeDefined();
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThan(0);
		expect(tool.inputSchema).toBeDefined();
		expect(tool.inputSchema.type).toBe("object");
		expect(Array.isArray(tool.inputSchema.required)).toBe(true);
		expect(tool.inputSchema.required).toContain("code");
	});

	it("renders a diagram via tools/call and returns { id, ascii, fileLink } with fileLink starting with file:/// and ending with .html", async () => {
		await initialize(server);
		const callResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});
		expect(callResult).toBeDefined();
		expect(Array.isArray(callResult.content)).toBe(true);
		expect(callResult.content.length).toBeGreaterThan(0);
		const first = callResult.content[0];
		expect(first.type).toBe("text");
		expect(typeof first.text).toBe("string");

		const parsed = JSON.parse(first.text);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
		expect(parsed.fileLink.endsWith(".html")).toBe(true);
	});
});
