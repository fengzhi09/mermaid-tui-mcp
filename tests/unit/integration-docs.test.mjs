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

const CLOUD_BACKEND_SWITCH = "MERMAID_RENDERER_BACKEND=oss";
const CLOUD_REQUIRED_VARS = [
	"MERMAID_OSS_ENDPOINT",
	"MERMAID_OSS_REGION",
	"MERMAID_OSS_BUCKET",
	"MERMAID_OSS_ACCESS_KEY_ID",
	"MERMAID_OSS_SECRET_ACCESS_KEY",
];
const CLOUD_MIGRATION_KEYWORDS = ["migrate-to-oss", "bin/migrate-to-oss"];

describe("integration docs v0.3.0 cloud storage static check", () => {
	for (const { path } of FILES) {
		it(`${path} references the v0.3.0 cloud storage seam (env switch, 5 required OSS vars, migration CLI)`, () => {
			const abs = join(DOCS_DIR, path);
			const body = readFileSync(abs, "utf-8");
			// 1. Must reference the env switch (the only seam that flips the
			//    LocalFsStorage default to OssStorage)
			expect(body).toContain(CLOUD_BACKEND_SWITCH);
			// 2. Must mention at least 3 of the 5 required MERMAID_OSS_* vars
			//    (proves the cloud section actually carries the env-var table,
			//    not just a one-line mention)
			const requiredHits = CLOUD_REQUIRED_VARS.filter((v) =>
				body.includes(v),
			);
			expect(
				requiredHits.length,
				`${path} mentions ${requiredHits.length} of 5 required MERMAID_OSS_* vars [${requiredHits.join(", ")}], expected >= 3`,
			).toBeGreaterThanOrEqual(3);
			// 3. Must mention the migration CLI (name or path). openclaw.md is
			//    exempted: the OpenClaw workaround paths do not cover the
			//    migration CLI, same exemption pattern as the v0.2.0 tool-count
			//    rule above.
			if (path !== "openclaw.md") {
				const migrationHits = CLOUD_MIGRATION_KEYWORDS.filter((k) =>
					body.includes(k),
				);
				expect(
					migrationHits.length,
					`${path} mentions none of [${CLOUD_MIGRATION_KEYWORDS.join(", ")}]; expected at least 1 (the migration CLI)`,
				).toBeGreaterThanOrEqual(1);
			}
		});
	}
});
