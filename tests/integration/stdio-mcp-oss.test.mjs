// tests/integration/stdio-mcp-oss.test.mjs — M002/S01 integration-closure
// test. Drives the real server as a child process over stdio JSON-RPC, but
// with MERMAID_RENDERER_BACKEND=oss pointing at a real S3-compatible
// endpoint (canonical: MinIO on 127.0.0.1:9000 in Docker, but Aliyun OSS
// S3-compat and real AWS S3 also work). The 7 stdio MCP tools are
// exercised end-to-end against the cloud backend with zero changes to
// src/tools.mjs — the storage layer swap is invisible on the wire.
//
// What this file locks:
//   - The 7 tools (render_mermaid, pin_mermaid, unpin_mermaid, list_diagrams,
//     get_diagram, delete_mermaid, search_diagrams) all work when the
//     StorageBackend is OssStorage instead of LocalFsStorage.
//   - The R020 envelope (success → {content:[{type:"text", text:
//     JSON.stringify({...payload, elapsed_ms})}]}; failure → {isError:true,
//     content:[{type:"text", text: JSON.stringify({code, message,
//     retryable, elapsed_ms})}]}) is preserved through the cloud path.
//   - The strict-404 contract (MEM014): delete_mermaid / pin_mermaid /
//     get_diagram with a missing id return code -32005.
//   - The 200KB source limit contract (eval-07): render_mermaid with a
//     too-large code returns code -32602 with the same message shape
//     (mentions both the actual length and the max).
//   - sweep() drops unpinned-expired entries and leaves pinned-expired
//     entries in place, end-to-end against a real S3 bucket.
//
// Skip semantics: when MERMAID_OSS_ENDPOINT is unset, OR the endpoint
// does not accept a TCP connect within 1s, the file skips the entire
// suite with a clear skip reason. This keeps `npm test` green on
// machines without Docker/MinIO — the test is opt-in by exporting
// the env var, but always-on in CI when the env is wired up.
//
// Per-test isolation: a random MERMAID_OSS_PREFIX (mcp-s01-test-<rand>)
// is generated once at module-load and shared across all it() blocks
// in this file. The server is spawned with that env, every write goes
// under the prefix, and afterEach sweeps the prefix via ListObjectsV2
// + DeleteObjects so the bucket is clean for the next run. The per-test
// random prefix also keeps parallel test files from colliding if more
// than one is run at once.
//
// Proof artifacts (the S01 demo deliverables): when it() block 3
// passes, three files are written to tests/integration/oss-proofs/:
//   - tools-list.json     — the tools/list response (raw JSON-RPC result)
//   - render-result.json  — the render_mermaid call result
//   - file-link.html      — the rendered HTML viewer (copied from the
//                           server's <DATA>/blobs/<id>.html output)
//   - README.md           — human-readable index of the proof artifacts
//
// These are durable transcripts visible from the slice summary so an
// operator reviewing the milestone can see exactly what the S01 demo
// produced without re-running the test.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { spawnServer } from "../helpers/server.mjs";
import { probeForSkip, ensureOssBucket, sweepOssPrefix } from "../helpers/oss-fixture.mjs";
import { S3Client } from "@aws-sdk/client-s3";
import { OssStorage } from "../../src/storage/OssStorage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROOFS_DIR = resolve(__dirname, "oss-proofs");
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CLIENT_INFO = { name: "vitest-oss", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";
const EXPECTED_TOOL_NAMES_SORTED = [
	"delete_mermaid",
	"get_diagram",
	"list_diagrams",
	"pin_mermaid",
	"render_mermaid",
	"search_diagrams",
	"unpin_mermaid",
];
const VALID_GRAPH = "graph TD\n  A-->B";

/** Parse the single text item in a tools/call result.content[0] as JSON. */
function parseCallText(callResult) {
	expect(callResult).toBeDefined();
	expect(Array.isArray(callResult.content)).toBe(true);
	expect(callResult.content.length).toBeGreaterThan(0);
	const first = callResult.content[0];
	expect(first.type).toBe("text");
	expect(typeof first.text).toBe("string");
	return JSON.parse(first.text);
}

async function initialize(server) {
	return server.send("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

const endpoint = process.env.MERMAID_OSS_ENDPOINT;
const region = process.env.MERMAID_OSS_REGION || "us-east-1";
const accessKeyId = process.env.MERMAID_OSS_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.MERMAID_OSS_SECRET_ACCESS_KEY || "";
const bucket = process.env.MERMAID_OSS_BUCKET || "";
const randomSuffix = randomBytes(6).toString("hex");
const testPrefix = process.env.MERMAID_OSS_PREFIX
	? `${process.env.MERMAID_OSS_PREFIX}-${randomSuffix}`
	: `mcp-s01-test-${randomSuffix}`;

const envForServer = {
	MERMAID_RENDERER_BACKEND: "oss",
	MERMAID_OSS_ENDPOINT: endpoint,
	MERMAID_OSS_REGION: region,
	MERMAID_OSS_ACCESS_KEY_ID: accessKeyId,
	MERMAID_OSS_SECRET_ACCESS_KEY: secretAccessKey,
	MERMAID_OSS_BUCKET: bucket,
	MERMAID_OSS_FORCE_PATH_STYLE: "true",
	MERMAID_OSS_PREFIX: testPrefix,
};

// Build a separate S3Client for direct storage manipulation (sweep
// test, afterEach cleanup). Shares the same env as the server spawn.
function makeDirectClient() {
	if (!endpoint) return null;
	return new S3Client({
		region,
		endpoint,
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
	});
}

// Probe once at module load. The describe.skipIf() below consumes the
// boolean; the reason is surfaced via beforeAll so the test report
// shows the skip message clearly.
const initialProbe = await probeForSkip(endpoint, 1000);
const SUITE_SHOULD_RUN = initialProbe.reachable;

// Module-level skip reason for the beforeAll log. We attach the
// reason to a console output so the operator sees why the file
// was skipped even when vitest's reporter just says "skipped".
if (!SUITE_SHOULD_RUN) {
	// eslint-disable-next-line no-console
	console.warn(`[stdio-mcp-oss] skipped — ${initialProbe.reason}`);
}

describe.skipIf(!SUITE_SHOULD_RUN)("stdio MCP integration — oss backend (M002/S01)", () => {
	/** @type {S3Client | null} */
	let directClient;
	/** @type {ReturnType<typeof spawnServer> | null} */
	let server;

	beforeAll(async () => {
		// Always build the proofs dir so render-time writes don't
		// fail on the first run (mkdir recursive is idempotent).
		await mkdir(PROOFS_DIR, { recursive: true });

		// Best-effort bucket provisioning. The server's load() also
		// runs HeadBucket, so a missing bucket would surface there
		// too — we provision eagerly so the first test doesn't pay
		// the extra round-trip cost.
		directClient = makeDirectClient();
		if (directClient) {
			try {
				await ensureOssBucket(directClient, bucket, true);
			} catch (e) {
				throw new Error(`ensureOssBucket("${bucket}") failed: ${e?.message || e}`);
			}
		}
	});

	beforeEach(() => {
		// Defensive: the proofs dir may have been cleaned between
		// runs (e.g. by the operator). Ensure it exists before
		// every test so the writeFile calls in it() 3 don't
		// fail with ENOENT.
		return mkdir(PROOFS_DIR, { recursive: true });
	});

	afterEach(async () => {
		if (server) {
			try {
				await server.close();
			} catch {
				// close() rejects in-flight sends on shutdown; safe to ignore in cleanup
			}
			server = null;
		}
		// Sweep the prefix via the S3 client so the next test starts
		// clean. Errors are swallowed — a sweep failure should not
		// mask a real test assertion.
		if (directClient) {
			try {
				await sweepOssPrefix(directClient, bucket, testPrefix);
			} catch {
				// best-effort
			}
		}
	});

	// Helper: start a server with the test env. Each call gets a fresh
	// child process so load() re-reads the persisted state from S3 and
	// sweep() runs against the latest write set.
	function startServer() {
		server = spawnServer({ env: envForServer });
		return server;
	}

	it("1. completes the initialize handshake and reports serverInfo.name === 'mermaid-tui-mcp'", async () => {
		const s = startServer();
		const result = await initialize(s);
		expect(result).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(result.serverInfo.name).toBe("mermaid-tui-mcp");
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	});

	it("2. lists 7 tools in tools/list with the same CRUD surface as the local backend", async () => {
		const s = startServer();
		await initialize(s);
		const result = await s.send("tools/list", {});
		expect(result).toBeDefined();
		expect(Array.isArray(result.tools)).toBe(true);
		expect(result.tools.length).toBe(7);
		expect(result.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOL_NAMES_SORTED);
		for (const t of result.tools) {
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}
		const render = result.tools.find((t) => t.name === "render_mermaid");
		expect(render).toBeDefined();
		expect(Array.isArray(render.inputSchema.required)).toBe(true);
		expect(render.inputSchema.required).toContain("code");
	});

	it("3. renders a diagram via tools/call and writes 3 proof artifacts (tools-list.json, render-result.json, file-link.html)", async () => {
		const s = startServer();
		await initialize(s);

		// Re-fetch tools/list for the proof artifact (the test above
		// ran in a separate server and its tools/list is local to
		// that child process).
		const toolsList = await s.send("tools/list", {});

		// Render the canonical graph with a title so search() has
		// something to find in a later it() block.
		const callResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "oss proof" },
		});
		const rendered = parseCallText(callResult);

		expect(typeof rendered.id).toBe("string");
		expect(rendered.id.length).toBeGreaterThan(0);
		expect(typeof rendered.ascii).toBe("string");
		expect(rendered.ascii.length).toBeGreaterThan(0);
		expect(typeof rendered.fileLink).toBe("string");
		expect(rendered.fileLink.startsWith("file:///")).toBe(true);
		expect(rendered.fileLink.endsWith(".html")).toBe(true);
		expect(rendered.title).toBe("oss proof");
		expect(typeof rendered.elapsed_ms).toBe("number");
		expect(rendered.elapsed_ms).toBeGreaterThanOrEqual(0);

		// Write the 3 proof artifacts. The HTML is copied from the
		// server's <DATA>/blobs/<id>.html output — strip the
		// file:// prefix to get the local path.
		const htmlPath = rendered.fileLink.replace(/^file:\/\/\//, "");
		const htmlBody = await readFile(htmlPath, "utf-8");
		expect(htmlBody.length).toBeGreaterThan(0);

		const toolsListPath = resolve(PROOFS_DIR, "tools-list.json");
		const renderResultPath = resolve(PROOFS_DIR, "render-result.json");
		const fileLinkPath = resolve(PROOFS_DIR, "file-link.html");
		const readmePath = resolve(PROOFS_DIR, "README.md");

		await writeFile(toolsListPath, JSON.stringify(toolsList, null, 2) + "\n", "utf-8");
		await writeFile(renderResultPath, JSON.stringify(callResult, null, 2) + "\n", "utf-8");
		await writeFile(fileLinkPath, htmlBody, "utf-8");

		// README is overwritten on every run; cheap and idempotent.
		const readme = [
			"# M002/S01 — OSS proof artifacts",
			"",
			`Generated by \`tests/integration/stdio-mcp-oss.test.mjs\` at ${new Date().toISOString()}.`,
			"",
			"| Artifact | Source | Purpose |",
			"| --- | --- | --- |",
			"| tools-list.json | tools/list response | Locks the 7-tool surface over the oss backend |",
			"| render-result.json | tools/call render_mermaid response | Locks the R020 success envelope over the oss backend |",
			"| file-link.html | copied from server's <DATA>/blobs/<id>.html | The rendered diagram the LLM would see at file:// |",
			"",
			`Endpoint: \`${endpoint}\`  `,
			`Bucket: \`${bucket}\`  `,
			`Prefix: \`${testPrefix}\`  `,
			`Region: \`${region}\`  `,
			`Rendered id: \`${rendered.id}\`  `,
			`Rendered title: \`${rendered.title}\`  `,
		].join("\n");
		await writeFile(readmePath, readme, "utf-8");

		// Sanity: all 4 files exist on disk and have non-zero size.
		for (const p of [toolsListPath, renderResultPath, fileLinkPath, readmePath]) {
			const stat = await readFile(p, "utf-8");
			expect(stat.length).toBeGreaterThan(0);
		}
	});

	it("4. list_diagrams returns the rendered id after a render", async () => {
		const s = startServer();

		// Render so the list has something to find.
		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "list target" },
		});
		const rendered = parseCallText(renderResult);

		const listResult = await s.send("tools/call", {
			name: "list_diagrams",
			arguments: { limit: 100 },
		});
		const listBody = parseCallText(listResult);
		expect(Array.isArray(listBody.items)).toBe(true);
		const hit = listBody.items.find((e) => e.id === rendered.id);
		expect(hit).toBeDefined();
		expect(hit.title).toBe("list target");
		expect(hit.code).toBe(VALID_GRAPH);
		expect(hit.pinned).toBe(false);
	});

	it("5. get_diagram returns the full object including title, code, svg, createdAt, pinned=false, sourceLength", async () => {
		const s = startServer();

		const title = "Get target";
		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title },
		});
		const id = parseCallText(renderResult).id;

		const getResult = await s.send("tools/call", {
			name: "get_diagram",
			arguments: { id },
		});
		const body = parseCallText(getResult);

		expect(body.id).toBe(id);
		expect(body.title).toBe(title);
		expect(body.code).toBe(VALID_GRAPH);
		expect(typeof body.ascii).toBe("string");
		/* S03 ASCII-on-disk: get_diagram now returns the original render's ASCII (was ""). */
		expect(typeof body.ascii).toBe("string");
		expect(body.ascii.length).toBeGreaterThan(0); // ASCII not re-rendered on read (LocalFsStorage parity)
		expect(typeof body.svg).toBe("string");
		expect(body.svg).toContain("<svg");
		expect(typeof body.createdAt).toBe("number");
		expect(typeof body.lastAccessedAt).toBe("number");
		expect(body.pinned).toBe(false);
		expect(body.sourceLength).toBe(VALID_GRAPH.length);
	});

	it("6. pin_mermaid over stdio MCP flips pinned: true", async () => {
		const s = startServer();

		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "pin target" },
		});
		const id = parseCallText(renderResult).id;

		const pinResult = await s.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id },
		});
		const pinned = parseCallText(pinResult);
		expect(pinned).toMatchObject({ id, pinned: true });

		// Ground-truth: list with pinned:true sees the entry.
		const listResult = await s.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(listBody.items.some((e) => e.id === id && e.pinned === true)).toBe(true);
	});

	it("7. unpin_mermaid over stdio MCP is the dual of pin_mermaid", async () => {
		const s = startServer();

		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "unpin target" },
		});
		const id = parseCallText(renderResult).id;

		await s.send("tools/call", { name: "pin_mermaid", arguments: { id } });
		const unpinResult = await s.send("tools/call", { name: "unpin_mermaid", arguments: { id } });
		const unpinned = parseCallText(unpinResult);
		expect(unpinned).toMatchObject({ id, pinned: false });

		// Ground-truth: list with pinned:true no longer sees it.
		const listResult = await s.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(listBody.items.some((e) => e.id === id)).toBe(false);
	});

	it("8. search_diagrams over stdio MCP matches the code with a substring hit (graph TD)", async () => {
		const s = startServer();

		// Render with a known code containing "graph TD".
		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "search target" },
		});
		const id = parseCallText(renderResult).id;

		const searchResult = await s.send("tools/call", {
			name: "search_diagrams",
			arguments: { query: "graph TD" },
		});
		const searchBody = parseCallText(searchResult);
		expect(Array.isArray(searchBody.items)).toBe(true);
		const hit = searchBody.items.find((e) => e.id === id);
		expect(hit).toBeDefined();
		expect(hit.titleMatch).toBe(false); // hit was in the code, not the title
		expect(typeof hit.snippet).toBe("string");
		expect(hit.snippet.toLowerCase()).toContain("graph td");
	});

	it("9. delete_mermaid over stdio MCP returns deleted: true and the follow-up get is a strict 404", async () => {
		const s = startServer();

		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "delete target" },
		});
		const id = parseCallText(renderResult).id;

		const delResult = await s.send("tools/call", { name: "delete_mermaid", arguments: { id } });
		const deleted = parseCallText(delResult);
		expect(deleted).toMatchObject({ id, deleted: true });

		// Follow-up get is a strict 404 (MEM014).
		const followup = await s.send("tools/call", { name: "get_diagram", arguments: { id } });
		expect(followup.isError).toBe(true);
		const followupBody = parseCallText(followup);
		expect(followupBody.code).toBe(-32005);
		expect(followupBody.retryable).toBe(false);
	});

	it("10. delete_mermaid with a missing id returns isError: true with code -32005 (strict 404, MEM014)", async () => {
		const s = startServer();
		const result = await s.send("tools/call", { name: "delete_mermaid", arguments: { id: "nonexistent" } });
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		expect(body.code).toBe(-32005);
		expect(body.retryable).toBe(false);
	});

	it("11. sweep drops the unpinned-expired entry and leaves the pinned-expired entry (direct OssStorage manipulation against the real bucket)", async () => {
		// Use the MCP server to render + pin so the entries are
		// persisted through the real tool surface. Then backdate
		// their createdAt via a direct OssStorage instance and
		// call sweep() to verify the contract.
		const s = startServer();
		await initialize(s);

		// 1. Render two diagrams; pin one, leave the other unpinned.
		const renderA = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: VALID_GRAPH, title: "sweep A" },
		});
		const idA = parseCallText(renderA).id;
		const renderB = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph LR\n  X-->Y", title: "sweep B" },
		});
		const idB = parseCallText(renderB).id;

		await s.send("tools/call", { name: "pin_mermaid", arguments: { id: idB } });

		// 2. Build a direct OssStorage that points at the same
		// bucket+prefix. Backdate both entries' createdAt to TTL+1
		// ago, then call sweep().
		const storage = new OssStorage({
			bucket,
			prefix: testPrefix,
			client: directClient,
		});
		await storage.load();
		// load() already ran sweep; both entries are fresh, so
		// nothing was removed. Backdate them now and re-run sweep.
		const entryA = storage.getMetadata(idA);
		const entryB = storage.getMetadata(idB);
		expect(entryA).toBeDefined();
		expect(entryB).toBeDefined();
		expect(entryA.pinned).toBe(false);
		expect(entryB.pinned).toBe(true);
		if (entryA) entryA.createdAt = Date.now() - TTL_MS - 1000;
		if (entryB) entryB.createdAt = Date.now() - TTL_MS - 1000;
		await storage.save();

		const removed = await storage.sweep();
		expect(removed).toBe(1);
		expect(storage.getMetadata(idA)).toBeNull();
		expect(storage.getMetadata(idB)).toBeDefined();
		expect(storage.getMetadata(idB).pinned).toBe(true);
	});

	// ==========================================================================
	// Negative tests (Q7)
	// ==========================================================================

	it("N1. render_mermaid with a too-large code (200_001 chars) returns isError: true with code -32602 (eval-07 contract preserved)", async () => {
		const s = startServer();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "a".repeat(200_001) },
		});
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		expect(body.code).toBe(-32602);
		expect(body.retryable).toBe(false);
		expect(body.message).toContain("200001");
		expect(body.message).toContain("200000");
	});

	it("N2. pin_mermaid with a missing id returns isError: true with code -32005 (strict 404, MEM014)", async () => {
		const s = startServer();
		const result = await s.send("tools/call", { name: "pin_mermaid", arguments: { id: "nope" } });
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		expect(body.code).toBe(-32005);
		expect(body.retryable).toBe(false);
	});

	it("N3. get_diagram with a missing id returns isError: true with code -32005 (strict 404, MEM014)", async () => {
		const s = startServer();
		const result = await s.send("tools/call", { name: "get_diagram", arguments: { id: "nope" } });
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		expect(body.code).toBe(-32005);
		expect(body.retryable).toBe(false);
	});
});
