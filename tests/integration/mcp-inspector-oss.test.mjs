// tests/integration/mcp-inspector-oss.test.mjs — M002/S03/T02
//
// Protocol-level smoke proving the v0.3.0 server is drivable by an
// independent stdio MCP client implementation over the **oss**
// backend (real S3-compatible storage, canonical: MinIO on
// 127.0.0.1:9000 in Docker). Complements S04 mcp-inspector.test.mjs
// (which proves the same shape against the local backend) and
// stdio-mcp-oss.test.mjs (which proves the helper-driven 14 it()
// coverage against the cloud backend). This file is the
// protocol-layer proof (R020 envelope, MEM024 id projection) that
// the 7-tool surface is reachable through the same wire shape a
// real `@modelcontextprotocol/inspector` CLI client would see, over
// `MERMAID_RENDERER_BACKEND=oss`.
//
// What this file proves (5 it() blocks):
//   1. initialize handshake + serverInfo.name + version string present
//   2. tools/list returns exactly the 7 v0.3.0 tools, and a proof
//      artifact `oss-proofs/mcp-inspector-tools-list.json` is written
//      so the S03 demo has a durable transcript of the cloud-side
//      tool surface
//   3. tools/call render_mermaid returns the R020 success envelope
//      (content[0].text parses to {id, ascii, fileLink, httpLink,
//      title, elapsed_ms}; isError === undefined)
//   4. tools/call pin_mermaid returns a success envelope with
//      pinned: true
//   5. tools/call search_diagrams finds the diagram by title
//      substring and the result item carries an `id` field
//      (MEM024 wire-level closure over the cloud path)
//
// Driver: spawn `node src/server.mjs` directly, write one JSON-RPC
// frame per line to its stdin, read NDJSON responses from its
// stdout. Identical to the on-the-wire pattern the
// @modelcontextprotocol/inspector CLI uses against a stdio server
// — so a green test here is a green test for the Inspector
// surface over the oss backend.
//
// Skip semantics: when MERMAID_OSS_ENDPOINT is unset, OR the
// endpoint does not accept a TCP connect within 1s, the file skips
// the entire suite with a clear skip reason. This keeps `npm test`
// green on machines without Docker/MinIO — the test is opt-in by
// exporting the env var, but always-on in CI when the env is wired
// up (MEM036).
//
// Per-test isolation: a random MERMAID_OSS_PREFIX
// (mcp-s03-inspector-test-<rand>) is generated once at module-load
// and shared across all it() blocks in this file. The server is
// spawned with that env, every write goes under the prefix, and
// afterEach sweeps the prefix via ListObjectsV2 + DeleteObjects so
// the bucket is clean for the next run. The per-test random prefix
// also keeps parallel test files from colliding if more than one
// is run at once (the randomized suffix is unique per process).

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";

import { probeForSkip, ensureOssBucket, sweepOssPrefix } from "../helpers/oss-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "..", "src", "server.mjs");
const PROOFS_DIR = resolve(__dirname, "oss-proofs");

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcp-inspector-oss-smoke", version: "0.0.0" };
const EXPECTED_TOOL_NAMES = [
	"delete_mermaid",
	"get_diagram",
	"list_diagrams",
	"pin_mermaid",
	"render_mermaid",
	"search_diagrams",
	"unpin_mermaid",
];

/**
 * Spawn a fresh server child and return a minimal JSON-RPC driver.
 * Each `request(method, params)` sends one frame and resolves with
 * the matching response by `id`. Stdout is parsed as NDJSON. Errors
 * with {code, message} come back as thrown Error with a `.rpcError`
 * field. This is intentionally NOT a wrapper over
 * `tests/helpers/server.mjs` — it's the same independent driver
 * shape `mcp-inspector.test.mjs` uses, parameterized by the
 * caller-supplied `env` (which injects the oss backend + prefix).
 */
function spawnInspectorClient(env) {
	const child = spawn("node", [SERVER_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});

	let buffer = "";
	let nextId = 0;
	const pending = new Map();
	const stderrChunks = [];
	let closed = false;

	child.stderr.on("data", (chunk) => stderrChunks.push(chunk.toString("utf-8")));

	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf-8");
		let idx;
		while ((idx = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				// server may log non-JSON; ignore for protocol purposes
				continue;
			}
			if (msg && typeof msg === "object" && msg.id != null && pending.has(msg.id)) {
				pending.get(msg.id)(msg);
				pending.delete(msg.id);
			}
		}
	});

	child.on("error", (err) => {
		// surface spawn errors to outstanding waiters
		for (const reject of pending.values()) reject(err);
		pending.clear();
	});

	function request(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			if (closed) return reject(new Error("client closed"));
			pending.set(id, (msg) => {
				if (msg.error) {
					const err = new Error(msg.error.message || JSON.stringify(msg.error));
					err.rpcError = msg.error;
					reject(err);
				} else {
					resolve(msg.result);
				}
			});
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				id,
				method,
				params: params ?? {},
			});
			child.stdin.write(payload + "\n", (err) => {
				if (err) reject(err);
			});
		});
	}

	function close() {
		return new Promise((resolve) => {
			if (closed) return resolve({ stderr: "" });
			closed = true;
			child.once("close", () => {
				resolve({ stderr: stderrChunks.join("") });
			});
			try {
				child.stdin.end();
			} catch {
				// best-effort
			}
			// hard-kill after 1s if it does not exit on stdin end
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 1000).unref();
		});
	}

	return { request, close };
}

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

async function initialize(client) {
	return client.request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: CLIENT_INFO,
	});
}

// Env block: read MERMAID_OSS_* at module load; build the env that
// the server child will be spawned with. Per-run randomized prefix
// preserves per-test isolation across parallel runs / parallel test
// files.
const endpoint = process.env.MERMAID_OSS_ENDPOINT;
const region = process.env.MERMAID_OSS_REGION || "us-east-1";
const accessKeyId = process.env.MERMAID_OSS_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.MERMAID_OSS_SECRET_ACCESS_KEY || "";
const bucket = process.env.MERMAID_OSS_BUCKET || "";
const randomSuffix = randomBytes(6).toString("hex");
const testPrefix = process.env.MERMAID_OSS_PREFIX
	? `${process.env.MERMAID_OSS_PREFIX}-${randomSuffix}`
	: `mcp-s03-inspector-test-${randomSuffix}`;

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

// Build a separate S3Client for direct storage manipulation
// (afterEach cleanup sweep). Shares the same env as the server
// spawn.
function makeDirectClient() {
	if (!endpoint) return null;
	return new S3Client({
		region,
		endpoint,
		forcePathStyle: true,
		credentials: { accessKeyId, secretAccessKey },
	});
}

// Probe once at module load. The describe.skipIf() below consumes
// the boolean; the reason is surfaced via console.warn so the
// operator sees why the file was skipped even when vitest's
// reporter just says "skipped".
const initialProbe = await probeForSkip(endpoint, 1000);
const SUITE_SHOULD_RUN = initialProbe.reachable;

if (!SUITE_SHOULD_RUN) {
	// eslint-disable-next-line no-console
	console.warn(`[mcp-inspector-oss] skipped — ${initialProbe.reason}`);
}

describe.skipIf(!SUITE_SHOULD_RUN)("MCP Inspector protocol smoke — oss backend (M002/S03)", () => {
	/** @type {S3Client | null} */
	let directClient;
	/** @type {ReturnType<typeof spawnInspectorClient> | null} */
	let client;

	beforeAll(async () => {
		// Always build the proofs dir so it() 2's writeFile calls
		// don't fail on the first run (mkdir recursive is
		// idempotent).
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
		// every test so the writeFile calls in it() 2 don't fail
		// with ENOENT.
		return mkdir(PROOFS_DIR, { recursive: true });
	});

	afterEach(async () => {
		if (client) {
			try {
				await client.close();
			} catch {
				// best-effort
			}
			client = null;
		}
		// Sweep the prefix via the S3 client so the next test
		// starts clean. Errors are swallowed — a sweep failure
		// should not mask a real test assertion.
		if (directClient) {
			try {
				await sweepOssPrefix(directClient, bucket, testPrefix);
			} catch {
				// best-effort
			}
		}
	});

	it("1. initialize handshake returns serverInfo.name === 'mermaid-tui-mcp' with a non-empty version", async () => {
		client = spawnInspectorClient(envForServer);
		const result = await initialize(client);
		expect(result).toBeDefined();
		expect(result.serverInfo).toBeDefined();
		expect(result.serverInfo.name).toBe("mermaid-tui-mcp");
		// The v0.3.0 contract pins a non-empty version string.
		// Tests do not pin the exact value (semver may advance) but
		// it must be a non-empty string.
		expect(typeof result.serverInfo.version).toBe("string");
		expect(result.serverInfo.version.length).toBeGreaterThan(0);
	});

	it("2. tools/list returns the 7 v0.3.0 tools with name + description + non-empty inputSchema, and writes the cloud-side tools/list to oss-proofs/mcp-inspector-tools-list.json", async () => {
		client = spawnInspectorClient(envForServer);
		await initialize(client);
		const result = await client.request("tools/list", {});
		expect(result).toBeDefined();
		expect(Array.isArray(result.tools)).toBe(true);
		// 7-tool surface is the v0.3.0 contract
		expect(result.tools.length).toBe(7);
		expect(result.tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
		// Each tool must carry a non-empty description and a
		// JSON-schema inputSchema (the latter is the wire contract
		// for LLM clients).
		for (const t of result.tools) {
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(t.inputSchema).toBeDefined();
			expect(t.inputSchema.type).toBe("object");
		}

		// Proof artifact: the cloud-side tools/list response,
		// captured from the v0.3.0 server running with
		// MERMAID_RENDERER_BACKEND=oss. Pairs with the
		// stdio-mcp-oss proof artifacts in the same dir.
		const toolsListPath = resolve(PROOFS_DIR, "mcp-inspector-tools-list.json");
		const readmePath = resolve(PROOFS_DIR, "README.md");
		await writeFile(toolsListPath, JSON.stringify(result, null, 2) + "\n", "utf-8");

		const readme = [
			"# M002/S03 — oss-proofs/mcp-inspector-tools-list.json",
			"",
			"Generated by `tests/integration/mcp-inspector-oss.test.mjs`.",
			"",
			"The artifact `mcp-inspector-tools-list.json` is the **cloud-side** `tools/list`",
			"response captured from `node src/server.mjs` running with",
			"`MERMAID_RENDERER_BACKEND=oss` and a randomized `MERMAID_OSS_PREFIX`.",
			"",
			"It is the protocol-layer complement to the helper-driven proof artifacts in",
			"`stdio-mcp-oss.test.mjs` (tools-list.json, render-result.json, file-link.html):",
			"this file proves the 7-tool surface is reachable through the same wire shape a",
			"real `@modelcontextprotocol/inspector` CLI client would see, over the oss",
			"backend.",
			"",
			"| Artifact | Source | Purpose |",
			"| --- | --- | --- |",
			"| mcp-inspector-tools-list.json | `tools/list` response over oss backend | Locks the 7-tool surface via the independent MCP-Inspector-style stdio driver |",
			"",
			`Endpoint: \`${endpoint}\`  `,
			`Bucket: \`${bucket}\`  `,
			`Prefix: \`${testPrefix}\`  `,
			`Region: \`${region}\`  `,
		].join("\n");
		await writeFile(readmePath, readme, "utf-8");

		// Sanity: both files exist on disk and have non-zero size.
		const toolsListStat = await readFile(toolsListPath, "utf-8");
		const readmeStat = await readFile(readmePath, "utf-8");
		expect(toolsListStat.length).toBeGreaterThan(0);
		expect(readmeStat.length).toBeGreaterThan(0);
	});

	it("3. tools/call render_mermaid returns the R020 success envelope (id, ascii, fileLink, httpLink, title, elapsed_ms)", async () => {
		client = spawnInspectorClient(envForServer);
		await initialize(client);
		const callResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: {
				code: "graph TD\n  A-->B",
				title: "Inspector smoke",
			},
		});
		expect(callResult).toBeDefined();
		// The R020 success shape is { content: [{type:"text", text: "<json>"}] }
		// with NO top-level isError field (isError is only set on failure).
		expect(callResult.isError).toBeUndefined();
		const body = parseCallText(callResult);
		// R020 success envelope: every documented field is present
		expect(typeof body.id).toBe("string");
		expect(body.id.length).toBeGreaterThan(0);
		expect(typeof body.ascii).toBe("string");
		expect(body.ascii.length).toBeGreaterThan(0);
		expect(typeof body.fileLink).toBe("string");
		expect(body.fileLink).toMatch(/^file:\/\//);
		// httpLink is null when HTTP daemon is not running — both
		// values are valid wire shapes
		expect(body.httpLink === null || typeof body.httpLink === "string").toBe(true);
		expect(body.title).toBe("Inspector smoke");
		expect(typeof body.elapsed_ms).toBe("number");
		expect(body.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("4. tools/call pin_mermaid returns the R020 success envelope with pinned: true", async () => {
		// Set up: render first, then pin
		client = spawnInspectorClient(envForServer);
		await initialize(client);
		const renderResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  X-->Y", title: "pin-target" },
		});
		const rendered = parseCallText(renderResult);
		expect(rendered.id).toBeDefined();

		// Pin it
		const pinResult = await client.request("tools/call", {
			name: "pin_mermaid",
			arguments: { id: rendered.id },
		});
		expect(pinResult.isError).toBeUndefined();
		const pinBody = parseCallText(pinResult);
		expect(pinBody.id).toBe(rendered.id);
		expect(pinBody.pinned).toBe(true);
		expect(typeof pinBody.elapsed_ms).toBe("number");
	});

	it("5. tools/call search_diagrams finds by title substring and the result item carries an `id` (MEM024 wire-level closure)", async () => {
		client = spawnInspectorClient(envForServer);
		await initialize(client);
		// Render a uniquely-titled diagram
		const uniqueTitle = `inspector-search-${Date.now()}`;
		const renderResult = await client.request("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  P-->Q", title: uniqueTitle },
		});
		expect(renderResult.isError).toBeUndefined();

		// Search for it by title substring
		const searchResult = await client.request("tools/call", {
			name: "search_diagrams",
			arguments: { query: uniqueTitle },
		});
		expect(searchResult.isError).toBeUndefined();
		const body = parseCallText(searchResult);
		expect(Array.isArray(body.items)).toBe(true);
		expect(body.items.length).toBeGreaterThan(0);
		// MEM024: each search result item MUST carry an `id` so the
		// caller can pin/get/delete by reference. Locked at the
		// wire level (the same `id` OssStorage.list/.search
		// project) — over the cloud path this proves the S3
		// round-trip carries the id through the JSON-RPC envelope.
		for (const item of body.items) {
			expect(typeof item.id).toBe("string");
			expect(item.id.length).toBeGreaterThan(0);
		}
		// And the matching item is present
		const hit = body.items.find((i) => i.title === uniqueTitle);
		expect(hit).toBeDefined();
		expect(hit.titleMatch).toBe(true);
	});
});
