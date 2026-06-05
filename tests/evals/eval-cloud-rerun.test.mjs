// tests/evals/eval-cloud-rerun.test.mjs — M002 / S03 / T05
//
// Cloud-backend re-run of the 10 local-backend evals. Each it() block
// mirrors one of the 10 local contracts (eval-01 through eval-10) but
// exercises the v0.3.0 7-tool stdio MCP surface (not the render() core
// directly) against the real S3-compatible storage backend
// (MERMAID_RENDERER_BACKEND=oss).
//
// Why this file exists:
//   - The local-backend evals (eval-01..10) prove the S01/S02/S03
//     contracts pass on the on-disk LocalFsStorage. R027's
//     "10/10 evals pass" gate is judged on that run.
//   - This file is the defense-in-depth re-run that proves the
//     v0.3.0 7-tool surface is reachable end-to-end through
//     `MERMAID_RENDERER_BACKEND=oss`. When the MinIO gate passes
//     (MEM036), all 10 it() blocks are green; when it doesn't, the
//     whole file skips with a clear reason.
//
// MEM043 constraint honored: this file does NOT add a vitest
// setupFiles that sets MERMAID_RENDERER_BACKEND=oss globally.
// Adding one would risk breaking the local-backend R027 gate
// (the 10 local evals must keep running against the local backend
// — that is the gate the milestone is judged on). The cloud
// backend is injected per-server-spawn inside the it() blocks.
//
// Skip semantics: when MERMAID_OSS_ENDPOINT is unset, OR the
// endpoint does not accept a TCP connect within 1s, the file
// skips the entire suite with a clear skip reason. Same pattern
// as S01 T04 (stdio-mcp-oss.test.mjs) and S03 T02
// (mcp-inspector-oss.test.mjs). Keeps `npm test` green on
// machines without Docker/MinIO.
//
// Per-test isolation: a random MERMAID_OSS_PREFIX
// (mcp-s03-eval-cloud-<6-byte-hex>) is generated once at
// module-load. Every server spawn uses that prefix; afterEach
// sweeps the prefix via ListObjectsV2 + DeleteObjects so the
// bucket is clean for the next run. Per-test randomized prefix
// also keeps parallel test files from colliding.
//
// What this file proves (10 it() blocks, 1:1 mirror of eval-01..10):
//   1. sequence diagram (TCP handshake) renders through stdio MCP
//      with non-empty ascii + fileLink
//   2. 3-subgraph flowchart (OAuth2 / OIDC) renders through stdio
//      MCP in a single call (id, ascii, fileLink all populated)
//   3. gantt chart (2-week sprint) renders through stdio MCP
//   4. malformed mermaid source is rejected with isError: true and
//      the "mermaid parse error:" prefix preserved over the cloud
//      backend
//   5. two render_mermaid calls produce two distinct ids
//   6. erDiagram renders through stdio MCP with non-empty fileLink
//   7. 200_001-char source is rejected with isError: true and
//      code -32602 (oversized-input contract preserved)
//   8. "draw anything" default — system architecture flowchart —
//      renders through stdio MCP
//   9. pin_mermaid over stdio MCP round-trips: render → pin →
//      list(pinned: true) sees it, list(pinned: false) does not
//  10. fileLink starts with file:/// AND the underlying .html
//      exists on disk (resolved through the .html the server
//      kept locally + uploaded to the bucket; the fileLink path
//      on the local data dir is reachable via fs/promises.access)

import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { spawnServer } from "../helpers/server.mjs";
import { probeForSkip, ensureOssBucket, sweepOssPrefix } from "../helpers/oss-fixture.mjs";
import { oversizedCode } from "../helpers/render-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_INFO = { name: "vitest-eval-cloud-rerun", version: "0.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

// Eval-01 (TCP handshake) — sequence diagram
const TCP_HANDSHAKE = [
	"sequenceDiagram",
	"  participant C",
	"  participant S",
	"  C->>S: SYN",
	"  S->>C: SYN+ACK",
	"  C->>S: ACK",
].join("\n");

// Eval-02 (three auth flows) — single 3-subgraph flowchart
const THREE_FLOWS = [
	"flowchart TD",
	'  subgraph AuthCode["OAuth2 Authorization Code"]',
	"    direction TB",
	"    U1[User] --> RP1[Relying Party]",
	"    RP1 --> AS1[Auth Server]",
	"    AS1 --> U1",
	"    AS1 --> RP1",
	"    RP1 --> AS1",
	"    AS1 --> RP1",
	"  end",
	'  subgraph ClientCreds["OAuth2 Client Credentials"]',
	"    direction TB",
	"    S1[Service] --> AS2[Auth Server]",
	"    AS2 --> S1",
	"  end",
	'  subgraph Implicit["OIDC Implicit"]',
	"    direction TB",
	"    U2[User] --> RP2[Relying Party]",
	"    RP2 --> AS3[Auth Server]",
	"    AS3 --> U2",
	"    AS3 --> RP2",
	"  end",
].join("\n");

// Eval-03 (gantt) — 2-week sprint with 5 tasks
const SPRINT_GANTT = [
	"gantt",
	"  title 2-Week Sprint",
	"  dateFormat YYYY-MM-DD",
	"  section S",
	"  design :a1, 2026-01-01, 2d",
	"  implementation :a2, after a1, 5d",
	"  review :a3, after a2, 2d",
	"  bug-fix :a4, after a3, 3d",
	"  deploy :a5, after a4, 1d",
].join("\n");

// Eval-04 (malformed) — mermaid 11 parser rejects the bad arrow.
// Mirrors tests/helpers/render-fixture.mjs MALFORMED.
const MALFORMED = "graph TD\n  A-->>B";

// Eval-06 (er diagram) — 5 entities, 4 relationships
const ER_DIAGRAM = [
	"erDiagram",
	"  USER ||--o{ ORDER : places",
	"  ORDER ||--|{ PRODUCT : contains",
	"  PRODUCT }o--|| CATEGORY : belongs_to",
	"  USER ||--o{ ADDRESS : has",
].join("\n");

// Eval-08 ("draw anything" default) — small system architecture flowchart
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

function fileLinkToPath(fileLink) {
	// strip the leading "file:///" and decode percent-escapes; on Windows
	// the remaining string is e.g. "C:/Users/...", on POSIX "/Users/...".
	const stripped = fileLink.startsWith("file:///") ? fileLink.slice("file:///".length) : fileLink;
	// decodeURIComponent so paths with spaces or unicode round-trip correctly
	return fileURLToPath("file:///" + stripped);
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
	: `mcp-s03-eval-cloud-${randomSuffix}`;

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
	console.warn(`[eval-cloud-rerun] skipped — ${initialProbe.reason}`);
}

describe.skipIf(!SUITE_SHOULD_RUN)("M002/S03 eval cloud re-run — oss backend (R027 defense-in-depth)", () => {
	/** @type {S3Client | null} */
	let directClient;
	/** @type {ReturnType<typeof spawnServer> | null} */
	let server;

	beforeAll(async () => {
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
		// Fresh server per it() block: load() re-reads S3 state and
		// the sweep runs against the latest write set.
		server = spawnServer({ env: envForServer });
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

	// Helper: initialize a freshly-spawned server. Each call returns
	// the initialize result so it() blocks can chain tools/list or
	// tools/call without repeating the handshake.
	async function initFresh() {
		const s = server;
		if (!s) throw new Error("server not spawned — beforeEach failure");
		await initialize(s);
		return s;
	}

	it("1. sequence diagram (TCP handshake) renders through stdio MCP with non-empty ascii + fileLink", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: TCP_HANDSHAKE },
		});
		const parsed = parseCallText(result);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
	});

	it("2. 3-subgraph flowchart (OAuth2 / OIDC) renders through stdio MCP in a single call with non-empty id + ascii + fileLink", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: THREE_FLOWS },
		});
		const parsed = parseCallText(result);
		// one call → one diagram
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(parsed.id).toMatch(/^m[a-z0-9]+$/);
		// both representations populated
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(typeof parsed.title).toBe("string");
		expect(typeof parsed.elapsed_ms).toBe("number");
		expect(parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
	});

	it("3. gantt chart (2-week sprint) renders through stdio MCP with non-empty result", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: SPRINT_GANTT, title: "cloud-gantt" },
		});
		const parsed = parseCallText(result);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.title).toBe("cloud-gantt");
		expect(typeof parsed.elapsed_ms).toBe("number");
	});

	it("4. malformed mermaid source is rejected with isError: true and a 'mermaid parse error:' message (R020 inner envelope preserved)", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: MALFORMED },
		});
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		// The renderer's canonical parse-error prefix must reach the
		// caller verbatim so the gsd-pi extension can show a useful
		// user-facing message (same contract as eval-04 on the
		// local backend).
		expect(typeof body.message).toBe("string");
		expect(body.message).toMatch(/^mermaid parse error:/);
		expect(body.retryable).toBe(false);
	});

	it("5. two render_mermaid calls produce two distinct ids + two distinct fileLinks", async () => {
		const s = await initFresh();
		const first = parseCallText(
			await s.send("tools/call", {
				name: "render_mermaid",
				arguments: { code: "graph TD\n  A-->B", title: "first" },
			}),
		);
		const second = parseCallText(
			await s.send("tools/call", {
				name: "render_mermaid",
				arguments: { code: "graph TD\n  A-->C\n  C-->B", title: "second" },
			}),
		);
		expect(typeof first.id).toBe("string");
		expect(typeof second.id).toBe("string");
		expect(first.id.length).toBeGreaterThan(0);
		expect(second.id.length).toBeGreaterThan(0);
		expect(first.id).not.toBe(second.id);
		// fileLink is the user-visible signal that the version is different
		expect(first.fileLink).not.toBe(second.fileLink);
	});

	it("6. erDiagram with 5 entities and 4 relationships renders through stdio MCP with non-empty fileLink", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: ER_DIAGRAM, title: "cloud-er" },
		});
		const parsed = parseCallText(result);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.fileLink.startsWith("file:///")).toBe(true);
		expect(parsed.title).toBe("cloud-er");
	});

	it("7. 200_001-char source is rejected with isError: true and code -32602 (oversized-input contract preserved over the cloud path)", async () => {
		const s = await initFresh();
		const code = oversizedCode(200_001);
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code },
		});
		expect(result.isError).toBe(true);
		const body = parseCallText(result);
		expect(body.code).toBe(-32602);
		expect(body.retryable).toBe(false);
		// The exact char count + the max are echoed so the caller can
		// surface the size limit to the user (same contract as eval-07).
		expect(body.message).toContain("200001");
		expect(body.message).toContain("200000");
	});

	it("8. 'draw anything' default — system architecture flowchart — renders through stdio MCP", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: SYSTEM_ARCHITECTURE, title: "cloud-architecture" },
		});
		const parsed = parseCallText(result);
		expect(typeof parsed.id).toBe("string");
		expect(parsed.id.length).toBeGreaterThan(0);
		expect(typeof parsed.ascii).toBe("string");
		expect(parsed.ascii.length).toBeGreaterThan(0);
		expect(typeof parsed.fileLink).toBe("string");
		expect(parsed.fileLink.length).toBeGreaterThan(0);
		expect(parsed.title).toBe("cloud-architecture");
	});

	it("9. pin_mermaid over stdio MCP round-trips: render → pin → list(pinned: true) sees it, list(pinned: false) does not", async () => {
		const s = await initFresh();
		// Render to seed an id
		const renderResult = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B", title: "cloud-eval-09-pin-target" },
		});
		const rendered = parseCallText(renderResult);
		expect(typeof rendered.id).toBe("string");
		expect(rendered.id.length).toBeGreaterThan(0);
		const seededId = rendered.id;

		// Pin it
		const pinResult = await s.send("tools/call", {
			name: "pin_mermaid",
			arguments: { id: seededId },
		});
		const pinned = parseCallText(pinResult);
		expect(pinned).toMatchObject({ id: seededId, pinned: true });
		expect(typeof pinned.elapsed_ms).toBe("number");
		expect(pinned.elapsed_ms).toBeGreaterThanOrEqual(0);

		// Ground-truth: list_diagrams({pinned: true}) sees the seeded id
		// (NOTE: list items don't carry id — we identify by title, which
		// is unique within this test.)
		const listResult = await s.send("tools/call", {
			name: "list_diagrams",
			arguments: { pinned: true },
		});
		const listBody = parseCallText(listResult);
		expect(
			listBody.items.some(
				(e) => e.title === "cloud-eval-09-pin-target" && e.pinned === true,
			),
		).toBe(true);

		// Ground-truth: list_diagrams({pinned: false}) does NOT see it
		const unpinnedList = parseCallText(
			await s.send("tools/call", {
				name: "list_diagrams",
				arguments: { pinned: false },
			}),
		);
		expect(
			unpinnedList.items.some((e) => e.title === "cloud-eval-09-pin-target"),
		).toBe(false);
	});

	it("10. fileLink starts with file:/// AND the underlying .html is reachable on disk (cloud-rendered .html is also kept locally)", async () => {
		const s = await initFresh();
		const result = await s.send("tools/call", {
			name: "render_mermaid",
			arguments: { code: "graph TD\n  A-->B", title: "cloud-eval-10-filelink" },
		});
		const parsed = parseCallText(result);
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
