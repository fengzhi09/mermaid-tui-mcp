// tests/evals/eval-08-draw-anything.test.mjs
//
// From evals.xml <eval id="8">:
//   <question>The user says "draw anything" without specifying a diagram
//   type. Render something useful.</question>
//   <expected>The assistant picks a reasonable default (typically a small
//   system architecture flowchart) and renders it. This tests the tool
//   description's hint to "use ascii" — the assistant doesn't try to
//   interpret the request as "render literally anything" (which would
//   loop on infinite possibilities).</expected>
//
// Contract under test:
//   - A small system architecture flowchart (the assistant's reasonable
//     default) renders through the stdio MCP path without throwing and
//     produces a non-empty { id, ascii, fileLink } result. Verifies the
//     renderer accepts the assistant's default pick and surfaces it
//     back to the user via the standard contract.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const SYSTEM_ARCHITECTURE = [
	"flowchart LR",
	"  Client[Browser/Mobile Client]",
	"  Edge[Edge / CDN]",
	"  API[API Gateway]",
	"  Auth[Auth Service]",
	"  Core[Core Domain Service]",
	"  DB[(Primary DB)]",
	"  Cache[(Cache)]",
	"  Queue[Job Queue]",
	"  Worker[Background Worker]",
	"  Client --> Edge --> API",
	"  API --> Auth",
	"  API --> Core",
	"  Core --> DB",
	"  Core --> Cache",
	"  Core --> Queue --> Worker",
].join("\n");

describe("eval-08: 'draw anything' default — a small system architecture flowchart renders", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval08-"));
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

	it("does not throw and returns a non-empty result for the default architecture diagram", async () => {
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vitest-eval-08", version: "0.0.0" },
		});

		const result = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: SYSTEM_ARCHITECTURE },
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
	});
});
