// tests/evals/eval-01-tcp-handshake.test.mjs
//
// From evals.xml <eval id="1">:
//   <question>Show me a flowchart of the TCP three-way handshake.</question>
//   <expected>The assistant calls render_mermaid({code: "sequenceDiagram\n..."
//   or a flowchart variant}), then pastes the ASCII art into the reply and
//   prints the fileLink so the user can open a full-rendered version.</expected>
//
// Contract under test:
//   - A sequence diagram for the TCP three-way handshake (C->S SYN,
//     S->C SYN+ACK, C->S ACK) renders successfully through the stdio MCP
//     path and returns { id, ascii, fileLink } with non-empty ascii and
//     a reachable fileLink.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const TCP_HANDSHAKE = [
	"sequenceDiagram",
	"  participant C",
	"  participant S",
	"  C->>S: SYN",
	"  S->>C: SYN+ACK",
	"  C->>S: ACK",
].join("\n");

describe("eval-01: TCP three-way handshake renders through stdio MCP", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval01-"));
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

	it("returns non-empty ascii and fileLink for a TCP handshake sequence diagram", async () => {
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vitest-eval-01", version: "0.0.0" },
		});

		const result = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: TCP_HANDSHAKE },
		});

		expect(result).toBeDefined();
		expect(Array.isArray(result.content)).toBe(true);
		const text = result.content[0].text;
		const parsed = JSON.parse(text);

		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
	});
});
