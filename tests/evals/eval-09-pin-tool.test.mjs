// tests/evals/eval-09-pin-tool.test.mjs
//
// From evals.xml <eval id="9">:
//   <question>Pin the diagram we just rendered (id=mabc123) so it doesn't
//   get cleaned up after 7 days.</question>
//   <expected>[S01 wording — now stale] This is HTTP-only. The stdio MCP
//   path does not expose a pin tool. The assistant tells the user that
//   pinning requires the standalone HTTP daemon (bin/start.sh) and that
//   the fileLink still works in the meantime. If the daemon is running,
//   the assistant explains how to use the view page's pin button (or calls
//   the HTTP /pin endpoint via exec).</expected>
//
// S02 (T04) reality: the v0.1.0 "HTTP-only" wording above is now stale.
// pin_mermaid IS a stdio MCP tool. This test exercises the full
// S02 contract: render → pin → list(pinned: true) round-trips through
// the stdio transport, with MERMAID_RENDERER_DATA pointed at a per-test
// temp dir so the real <repo>/data/ is never touched.
//
// Header note: this used to be a TDD placeholder (it.todo). T04 flipped
// it to a real assertion that passes against the S02 surface.

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

function parseCallText(callResult) {
	expect(callResult).toBeDefined();
	expect(Array.isArray(callResult.content)).toBe(true);
	expect(callResult.content.length).toBeGreaterThan(0);
	const first = callResult.content[0];
	expect(first.type).toBe("text");
	return JSON.parse(first.text);
}

describe("eval-09: pin_mermaid over stdio MCP (S02 flipped from it.todo)", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval-09-"));
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

	it("pins the just-rendered diagram so it survives the 7-day TTL sweep", async () => {
		// 1. initialize
		await initialize(server);

		// 2. render to seed an id
		const renderResult = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B", title: "eval-09 pin target" },
		});
		const rendered = parseCallText(renderResult);
		expect(typeof rendered.id).toBe("string");
		expect(rendered.id.length).toBeGreaterThan(0);
		const seededId = rendered.id;

		// 3. pin
		const pinResult = await server.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id: seededId },
		});
		const pinned = parseCallText(pinResult);
		expect(pinned).toMatchObject({ id: seededId, pinned: true });
		expect(typeof pinned.elapsed_ms).toBe("number");
		expect(pinned.elapsed_ms).toBeGreaterThanOrEqual(0);

		// 4. ground-truth: list_diagrams({pinned: true}) sees the seeded id
		// (NOTE: list items don't carry id — we identify by title, which is
		// unique within this test.)
		const listResult = await server.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(listBody.items.some((e) => e.title === "eval-09 pin target" && e.pinned === true)).toBe(true);

		// 5. ground-truth: list_diagrams({pinned: false}) does NOT see it
		const unpinnedList = parseCallText(
			await server.send("tools/call", {
				name: "list_diagrams",
				arguments: { pinned: false },
			}),
		);
		expect(unpinnedList.items.some((e) => e.title === "eval-09 pin target")).toBe(false);
	});
});
