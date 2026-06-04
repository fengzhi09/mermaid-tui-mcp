// tests/evals/eval-05-two-renders.test.mjs
//
// From evals.xml <eval id="5">:
//   <question>First, render the diagram "graph TD\n  A--&gt;B". Then, while
//   explaining, the assistant needs to add a node C between A and B. Use a
//   second render to show the updated diagram.</question>
//   <expected>Two render_mermaid calls. The second call's id is different
//   from the first. The assistant explicitly tells the user that this is
//   the updated version (different fileLink).</expected>
//
// Contract under test:
//   - Two render_mermaid calls over the stdio MCP path produce two
//     distinct ids. Monotonic id generation guarantees the second call
//     always has a different id from the first; the user's mental model
//     of "different fileLink = different version" is preserved.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const FIRST_GRAPH = "graph TD\n  A-->B";
const SECOND_GRAPH = "graph TD\n  A-->C\n  C-->B";

describe("eval-05: two render_mermaid calls produce two different ids", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval05-"));
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
		if (dataDir) await rm(dataDir, { recursive: true, force: true });
	});

	it("first and second render return distinct ids (and distinct fileLinks)", async () => {
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vitest-eval-05", version: "0.0.0" },
		});

		const first = JSON.parse(
			(await server.send("tools/call", { name: "render_mermaid", arguments: { code: FIRST_GRAPH } })).content[0].text,
		);
		const second = JSON.parse(
			(await server.send("tools/call", { name: "render_mermaid", arguments: { code: SECOND_GRAPH } })).content[0].text,
		);

		expect(typeof first.id).toBe("string");
		expect(typeof second.id).toBe("string");
		expect(first.id.length).toBeGreaterThan(0);
		expect(second.id.length).toBeGreaterThan(0);
		expect(first.id).not.toBe(second.id);
		// fileLink is the user-visible signal that the version is different
		expect(first.fileLink).not.toBe(second.fileLink);
	});
});
