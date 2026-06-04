// tests/evals/eval-10-file-link.test.mjs
//
// From evals.xml <eval id="10">:
//   <question>The user wants the file:// link to work on macOS. The
//   current path is "C:/Users/.../data/blobs/mabc.html". Will it open?</question>
//   <expected>fileLink paths are platform-correct (we generate `file:///`
//   with forward slashes). The assistant (or this test) should confirm
//   the path matches the host's filesystem — on macOS the path would
//   start with `/Users/...`, on Linux with `/home/...`, on Windows with
//   `C:/...`. The assistant adjusts the user-facing message to the
//   current OS if needed.</expected>
//
// Contract under test:
//   - A render_mermaid call returns a fileLink that starts with
//     `file:///` and references a .html file that exists on disk
//     (verified via fs/promises.access). The file:// URL uses forward
//     slashes regardless of host OS, per src/helpers.mjs#fileUrlFor.
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnServer } from "../helpers/server.mjs";

const PROTOCOL_VERSION = "2025-06-18";

function fileLinkToPath(fileLink) {
	// strip the leading "file:///" and decode percent-escapes; on Windows
	// the remaining string is e.g. "C:/Users/...", on POSIX "/Users/...".
	const stripped = fileLink.startsWith("file:///") ? fileLink.slice("file:///".length) : fileLink;
	// decodeURIComponent so paths with spaces or unicode round-trip correctly
	return fileURLToPath("file:///" + stripped);
}

describe("eval-10: fileLink from render_mermaid starts with file:/// and points to an existing .html on disk", () => {
	let dataDir;
	let server;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "mermaid-eval10-"));
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

	it("returns a file:/// link to a reachable .html on the host filesystem", async () => {
		await server.send("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "vitest-eval-10", version: "0.0.0" },
		});

		const result = await server.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B" },
		});

		const parsed = JSON.parse(result.content[0].text);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);

		// The .html must be reachable on disk. fileLinkToPath handles both
		// the windows "C:/..." and posix "/Users/..." shapes.
		const htmlPath = fileLinkToPath(parsed.fileLink);
		// resolves to a real .html under the per-test temp data dir
		expect(htmlPath.endsWith(join(`${parsed.id}.html`))).toBe(true);
		// fs/promises.access resolves only if the file exists and is readable
		await expect(access(htmlPath)).resolves.toBeUndefined();
	});
});
