// tests/unit/integration-docs.test.mjs — S04 / T05
//
// Doc static check: every `docs/integration/*.md` file must reference the
// v0.2.0 mermaid MCP server surface. This is a unit test (no child
// process) that locks the user-facing docs against silent drift.
//
// Contract per file (T05-PLAN):
//   - Contains the substring `mermaid` (the server name)
//   - Mentions at least 4 of the 7 tool names (render_mermaid,
//     pin_mermaid, unpin_mermaid, get_diagram, list_diagrams,
//     search_diagrams, delete_mermaid)
//   - openclaw.md is the workaround-only doc: it may mention only 1 of
//     the 7 tools (render_mermaid) because the workaround path is
//     render-only; the other 6 are stdio-MCP-only and unreachable
//     from OpenClaw. Exempt it from the 4-of-7 rule.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, "..", "..", "docs", "integration");

const TOOL_NAMES = [
	"render_mermaid",
	"pin_mermaid",
	"unpin_mermaid",
	"get_diagram",
	"list_diagrams",
	"search_diagrams",
	"delete_mermaid",
];

const FILES = [
	{ path: "claude-code.md", minToolHits: 4 },
	{ path: "gsd-pi.md", minToolHits: 4 },
	{ path: "hermes.md", minToolHits: 4 },
	{ path: "opencode.md", minToolHits: 4 },
	// OpenClaw has no native MCP; the workaround path covers render_mermaid
	// only. Allow it to mention just 1 tool (the workaround's render path).
	{ path: "openclaw.md", minToolHits: 1 },
];

describe("integration docs v0.2.0 static check", () => {
	for (const { path, minToolHits } of FILES) {
		it(`${path} mentions 'mermaid' and at least ${minToolHits} of the 7 v0.2.0 tool names`, () => {
			const abs = join(DOCS_DIR, path);
			const body = readFileSync(abs, "utf-8");
			// 1. Must reference the server name
			expect(body).toContain("mermaid");
			// 2. Must mention at least `minToolHits` of the 7 tool names
			const hits = TOOL_NAMES.filter((t) => body.includes(t));
			expect(
				hits.length,
				`${path} mentions ${hits.length} tool name(s) [${hits.join(", ")}], expected >= ${minToolHits}`,
			).toBeGreaterThanOrEqual(minToolHits);
		});
	}
});
