// tests/unit/extensions/gsd-pi-mermaid-client.test.mjs
//
// End-to-end test of the stdio + JSON-RPC transport that the
// extensions/gsd-pi-mermaid extension relies on. Uses the worktree's
// proven spawnServer helper (tests/helpers/server.mjs — same one the
// existing stdio-mcp / mcp-inspector tests use) to drive the real
// mermaid server, with the same wire protocol the extension uses.
//
// What this test proves:
//   1. The mermaid server is reachable via raw JSON-RPC over stdio.
//   2. Multi-line Mermaid code survives the roundtrip (real newlines in
//      → real newlines out, parser succeeds). This is the case the
//      gsd-pi mcp_call transport fails on (double-escapes \n).
//   3. Each of the 7 mermaid tools returns the documented envelope shape.
//   4. The strict-404 error path is preserved (-32005 on missing id).
//
// If this test ever fails after extensions/gsd-pi-mermaid/MermaidClient.ts
// is changed, the cause is almost certainly in the .ts (or in the wire
// format the mermaid server expects).

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { afterAll, beforeAll, describe, it } from "vitest";
import { spawnServer } from "../../helpers/server.mjs";

const CLIENT_INFO = { name: "vitest-gsd-pi-mermaid-test", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INIT_TIMEOUT_MS = 10_000;

let dataDir;
let server;

beforeAll(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "mermaid-pi-test-"));
	server = spawnServer({ env: { MERMAID_RENDERER_DATA: dataDir } });
	// Best-effort wait for the server to be ready: send initialize and expect
	// a serverInfo response. The server's MCP transport auto-handles the
	// handshake on the first request.
	const initResult = await server.send(
		"initialize",
		{
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		},
		// helpers/server.mjs send() takes the same JSON-RPC params — the
		// third arg is the per-call timeout in ms. The 4th is an abort signal.
		SERVER_INIT_TIMEOUT_MS,
	);
	assert.equal(initResult.serverInfo.name, "mermaid-tui-mcp");
	assert.equal(initResult.serverInfo.version, "0.3.0");
}, SERVER_INIT_TIMEOUT_MS);

afterAll(async () => {
	if (server) {
		try {
			await server.close();
		} catch {
			/* best-effort cleanup */
		}
	}
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe("gsd-pi-mermaid transport (raw stdio + JSON-RPC bypass)", () => {
	it("tools/list returns the 7 v0.3.0 mermaid tools", async () => {
		const resp = await server.send("tools/list", {});
		const tools = resp.tools.map((t) => t.name).sort();
		assert.deepEqual(tools, [
			"delete_mermaid",
			"get_diagram",
			"list_diagrams",
			"pin_mermaid",
			"render_mermaid",
			"search_diagrams",
			"unpin_mermaid",
		]);
	});

	it("CRITICAL: multi-line mermaid code survives the roundtrip (the bug mcp_call fails on)", async () => {
		// The mermaid server receives `code` with REAL newlines and parses
		// correctly. This is the exact case the broken mcp_call transport
		// cannot pass through — mcp_call would deliver literal `\n` to the
		// server and the parser would reject the single-line input.
		const multiLineCode = [
			"graph TD",
			"  A[Start] --> B[Process]",
			"  B --> C{Valid?}",
			"  C -->|Yes| D[Done]",
			"  C -->|No| E[Retry]",
			"  E --> B",
		].join("\n");
		const resp = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: multiLineCode, title: "multi-line-survives" },
		});
		const payload = JSON.parse(resp.content[0].text);
		assert.ok(typeof payload.id === "string" && payload.id.length > 0, "id should be a non-empty string");
		assert.ok(payload.fileLink && payload.fileLink.startsWith("file://"), "fileLink should be set");
		assert.equal(payload.title, "multi-line-survives");
		// If the bug regressed, code arrives as a single line and the parser
		// chokes, so we'd see `warnings` populated and ascii would be the
		// failure sentinel. We assert a clean render.
		assert.ok(
			!Array.isArray(payload.warnings) || payload.warnings.length === 0,
			`expected no parse warnings; got ${JSON.stringify(payload.warnings)}`,
		);
		assert.ok(
			payload.ascii && !payload.ascii.startsWith("[mermaid-ascii failed:"),
			`ascii should render cleanly, got: ${payload.ascii?.slice(0, 100)}`,
		);

		// Cleanup so subsequent tests start from a known state
		await server.send("tools/call", { name: "delete_mermaid", arguments: { id: payload.id } });
	});

	it("full 7-tool roundtrip works through the same transport the extension uses", async () => {
		// 1. render
		const r = JSON.parse(
			(
				await server.send("tools/call", {
					name: "render_mermaid",
					arguments: { code: ["graph LR", "  X --> Y", "  Y --> Z"].join("\n"), title: "test-roundtrip" },
				})
			).content[0].text,
		);
		assert.ok(r.id, "render returns id");
		const id = r.id;

		// 2. list shows 1 item with id (verifies MEM024 S02 surface-gap fix carries through)
		const listResp = JSON.parse(
			(await server.send("tools/call", { name: "list_diagrams", arguments: { limit: 10 } })).content[0].text,
		);
		assert.ok(listResp.items.length >= 1, "list should have ≥1 item");
		const found = listResp.items.find((it) => it.id === id);
		assert.ok(found, `list should include the rendered id (id field on items proves MEM024 closure)`);
		assert.equal(found.title, "test-roundtrip");

		// 3. get
		const g = JSON.parse(
			(await server.send("tools/call", { name: "get_diagram", arguments: { id } })).content[0].text,
		);
		assert.equal(g.id, id);
		assert.ok(g.svg && g.svg.includes("<svg"), "get should return svg");

		// 4. pin
		const p = JSON.parse(
			(await server.send("tools/call", { name: "pin_mermaid", arguments: { id } })).content[0].text,
		);
		assert.equal(p.pinned, true);

		// 5. unpin
		const u = JSON.parse(
			(await server.send("tools/call", { name: "unpin_mermaid", arguments: { id } })).content[0].text,
		);
		assert.equal(u.pinned, false);

		// 6. search
		const s = JSON.parse(
			(await server.send("tools/call", { name: "search_diagrams", arguments: { query: "roundtrip", limit: 5 } }))
				.content[0].text,
		);
		assert.ok(s.items.length >= 1, "search by title should find the diagram");
		assert.ok(s.items[0].titleMatch === true, "title hit should set titleMatch=true");

		// 7. delete
		const d = JSON.parse(
			(await server.send("tools/call", { name: "delete_mermaid", arguments: { id } })).content[0].text,
		);
		assert.equal(d.deleted, true);

		// 8. strict-404 error path on a missing id
		// The mermaid server wraps tool errors as `{ isError: true, content: [...] }`
		// with the JSON-encoded error envelope in `content[0].text`,
		// NOT as a JSON-RPC-level error. spawnServer resolves with msg.result,
		// so `missing` IS the result object directly.
		const missing = await server.send("tools/call", { name: "pin_mermaid", arguments: { id: "zzz_no_such" } });
		assert.equal(missing.isError, true, "missing id should set isError=true on result");
		const errPayload = JSON.parse(missing.content[0].text);
		assert.equal(errPayload.code, -32005, "error code should be -32005 (MEM014 strict 404)");
	});
});
