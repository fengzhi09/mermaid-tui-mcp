// tests/evals/eval-06-er-diagram.test.mjs
//
// From evals.xml <eval id="6">:
//   <question>Render an ER diagram with 5 entities: User, Order, Product,
//   Category, Address. The relationships: User places Orders, Orders
//   contain Products, Products belong to Categories, Users have
//   Addresses.</question>
//   <expected>The assistant calls render_mermaid with an erDiagram source.
//   The ASCII may be rough (erDiagram support in mermaid-ascii is
//   best-effort) but the fileLink is always available and renders the
//   diagram correctly in a browser.</expected>
//
// Contract under test:
//   - A 5-entity / 4-relationship erDiagram renders through the stdio MCP
//     path without throwing and produces a non-empty fileLink. ASCII
//     quality for erDiagram is not asserted (per the eval's explicit
//     best-effort note).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const ER_DIAGRAM = [
	"erDiagram",
	"  USER ||--o{ ORDER : places",
	"  ORDER ||--|{ PRODUCT : contains",
	"  PRODUCT }o--|| CATEGORY : belongs_to",
	"  USER ||--o{ ADDRESS : has",
].join("\n");

describe("eval-06: erDiagram with 5 entities and 4 relationships renders via stdio MCP", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval06-"));
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

	it("does not throw and returns a non-empty fileLink for the erDiagram", async () => {
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vitest-eval-06", version: "0.0.0" },
		});

		const result = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: ER_DIAGRAM },
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
	});
});
