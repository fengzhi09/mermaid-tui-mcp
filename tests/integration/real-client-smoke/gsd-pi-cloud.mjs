// tests/integration/real-client-smoke/gsd-pi-cloud.mjs — M002 / S03 / T05
//
// Cloud variant of gsd-pi.mjs. Same transport-level smoke pattern —
// gsd-pi 1.1.1 ships as an interactive installer, so we drive the
// same child process gsd-pi would spawn (node src/server.mjs)
// through the stdio JSON-RPC handshake directly, with the 5
// MERMAID_OSS_* env vars + MERMAID_RENDERER_BACKEND=oss injected
// into the child spawn env. Captures the same initialize +
// tools/list + tools/call render_mermaid sequence to gsd-pi-cloud.log.
//
// The cloud variant proves that the 7-tool stdio MCP surface
// reached by gsd-pi would also reach a real S3-compatible
// storage backend (canonical: MinIO on 127.0.0.1:9000). The
// file:// link returned by render_mermaid points at an .html
// the server produced by uploading the rendered SVG to the
// cloud bucket and copying the same self-contained viewer
// into <data>/blobs/<id>.html — so the log transcript is a
// defense-in-depth proof that gsd-pi would also work over the
// cloud backend.
//
// Usage: `node tests/integration/real-client-smoke/gsd-pi-cloud.mjs`
// Output: tests/integration/real-client-smoke/gsd-pi-cloud.log

import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "gsd-pi-cloud.log");
const SERVER_PATH = resolve(__dirname, "..", "..", "..", "src", "server.mjs");

function nowIso() {
	return new Date().toISOString();
}

function logLine(s) {
	process.stdout.write(s);
	appendFileSync(LOG_PATH, s, "utf-8");
}

function logSkipped(reason) {
	const endpoint = process.env.MERMAID_OSS_ENDPOINT || "(unset)";
	const bucket = process.env.MERMAID_OSS_BUCKET || "(unset)";
	const prefix = process.env.MERMAID_OSS_PREFIX || "(unset)";
	const banner = [
		"=========================================================",
		`gsd-pi CLOUD transport-level smoke @ ${nowIso()}`,
		`status: SKIPPED — ${reason}`,
		"---------------------------------------------------------",
		"CLOUD CONFIG (unmet — would be):",
		`  MERMAID_OSS_ENDPOINT: ${endpoint}`,
		`  MERMAID_OSS_BUCKET:   ${bucket}`,
		`  MERMAID_OSS_PREFIX:   ${prefix}`,
		"=========================================================",
		"",
	].join("\n");
	writeFileSync(LOG_PATH, banner, "utf-8");
}

async function main() {
	// 0. SKIPPED path: when the 5 MERMAID_OSS_* vars are missing the
	// server would exit(1) with `oss_init_failed` on the very first
	// request, so the handshake never completes. Match the
	// claude-code-cloud best-effort posture: write a SKIPPED banner
	// and exit 0. The transcript is the "we tried, here's the
	// reason" proof artifact.
	if (!process.env.MERMAID_OSS_ENDPOINT) {
		logSkipped("MERMAID_OSS_ENDPOINT env is unset");
		console.warn("gsd-pi CLOUD smoke skipped: MERMAID_OSS_ENDPOINT env is unset");
		process.exit(0);
	}

	// 1. Header documenting the gsd-pi limitation and the cloud config
	const endpoint = process.env.MERMAID_OSS_ENDPOINT || "(unset)";
	const bucket = process.env.MERMAID_OSS_BUCKET || "(unset)";
	const prefix = process.env.MERMAID_OSS_PREFIX || "(unset)";
	const header = [
		"=========================================================",
		`gsd-pi CLOUD transport-level smoke @ ${nowIso()}`,
		"---------------------------------------------------------",
		"LIMITATION: gsd-pi 1.1.1 ships as an interactive installer;",
		"there is no `gsd-pi --prompt \"...\"` non-interactive mode.",
		"This smoke proves the integration would work by driving the",
		"same child process gsd-pi would spawn (node src/server.mjs)",
		"through the stdio JSON-RPC handshake directly. gsd-pi is a",
		"UI wrapper on top of this surface.",
		"---------------------------------------------------------",
		"CLOUD CONFIG:",
		`  MERMAID_OSS_ENDPOINT: ${endpoint}`,
		`  MERMAID_OSS_BUCKET:   ${bucket}`,
		`  MERMAID_OSS_PREFIX:   ${prefix}`,
		"---------------------------------------------------------",
		"",
	];
	writeFileSync(LOG_PATH, header.join("\n"), "utf-8");

	// 2. Build a temp MCP config the way gsd-pi would (per docs/integration/gsd-pi.md).
	// The child spawn env below carries the 5 MERMAID_OSS_* vars +
	// MERMAID_RENDERER_BACKEND=oss so the spawned node sees the cloud
	// backend already wired up.
	const tmpDir = mkdtempSync(join(tmpdir(), "gsd-pi-cloud-smoke-"));
	const mcpJsonPath = join(tmpDir, "mcp.json");
	const mcpConfig = {
		mcpServers: {
			mermaid: {
				command: "node",
				args: [SERVER_PATH],
				env: {
					MERMAID_RENDERER_BACKEND: "oss",
					MERMAID_OSS_ENDPOINT: process.env.MERMAID_OSS_ENDPOINT || "",
					MERMAID_OSS_REGION: process.env.MERMAID_OSS_REGION || "us-east-1",
					MERMAID_OSS_ACCESS_KEY_ID: process.env.MERMAID_OSS_ACCESS_KEY_ID || "",
					MERMAID_OSS_SECRET_ACCESS_KEY: process.env.MERMAID_OSS_SECRET_ACCESS_KEY || "",
					MERMAID_OSS_BUCKET: process.env.MERMAID_OSS_BUCKET || "",
					MERMAID_OSS_FORCE_PATH_STYLE: "true",
					MERMAID_OSS_PREFIX: process.env.MERMAID_OSS_PREFIX || "",
				},
			},
		},
	};
	writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");
	logLine(`wrote ${mcpJsonPath}\n`);

	// 3. Spawn the same child process gsd-pi would spawn, with
	//    MERMAID_RENDERER_DATA pointed at a per-run temp dir + the
	//    cloud backend env injected.
	const dataDir = mkdtempSync(join(tmpdir(), "gsd-pi-cloud-smoke-data-"));
	const childEnv = {
		...process.env,
		MERMAID_RENDERER_DATA: dataDir,
		MERMAID_RENDERER_BACKEND: "oss",
		MERMAID_OSS_ENDPOINT: process.env.MERMAID_OSS_ENDPOINT || "",
		MERMAID_OSS_REGION: process.env.MERMAID_OSS_REGION || "us-east-1",
		MERMAID_OSS_ACCESS_KEY_ID: process.env.MERMAID_OSS_ACCESS_KEY_ID || "",
		MERMAID_OSS_SECRET_ACCESS_KEY: process.env.MERMAID_OSS_SECRET_ACCESS_KEY || "",
		MERMAID_OSS_BUCKET: process.env.MERMAID_OSS_BUCKET || "",
		MERMAID_OSS_FORCE_PATH_STYLE: "true",
		MERMAID_OSS_PREFIX: process.env.MERMAID_OSS_PREFIX || "",
	};
	const child = spawn("node", [SERVER_PATH], {
		stdio: ["pipe", "pipe", "pipe"],
		env: childEnv,
	});

	let buffer = "";
	let nextId = 0;
	const pending = new Map();
	const stderrChunks = [];

	child.stderr.on("data", (c) => {
		const s = c.toString("utf-8");
		stderrChunks.push(s);
	});
	child.stdout.on("data", (c) => {
		buffer += c.toString("utf-8");
		let i;
		while ((i = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (!line.trim()) continue;
			logLine(`[server stdout] ${line}\n`);
			try {
				const msg = JSON.parse(line);
				if (msg.id != null && pending.has(msg.id)) {
					pending.get(msg.id)(msg);
					pending.delete(msg.id);
				}
			} catch {
				// not JSON, skip
			}
		}
	});

	function send(method, params) {
		const id = ++nextId;
		return new Promise((resolve, reject) => {
			pending.set(id, (msg) => {
				if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
				else resolve(msg.result);
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
		});
	}

	async function step(label, fn) {
		logLine(`\n--- ${label} ---\n`);
		try {
			const out = await fn();
			logLine(`[OK] ${label}\n`);
			return out;
		} catch (err) {
			logLine(`[FAIL] ${label}: ${err.message}\n`);
			throw err;
		}
	}

	try {
		// 4. Drive the handshake: initialize → tools/list → tools/call render_mermaid
		await step("initialize", () =>
			send("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "gsd-pi-cloud-transport-smoke", version: "0.0.0" },
			}),
		);
		const toolsList = await step("tools/list", () => send("tools/list", {}));
		logLine(`[tools/list] ${toolsList.tools.length} tools: ${toolsList.tools.map((t) => t.name).join(", ")}\n`);
		const renderResult = await step("tools/call render_mermaid", () =>
			send("tools/call", {
				name: "render_mermaid",
				arguments: { code: "graph TD\n  A-->B", title: "gsd-pi-cloud-transport-smoke" },
			}),
		);
		const body = JSON.parse(renderResult.content[0].text);
		logLine(`[render] id=${body.id}, ascii.length=${body.ascii.length}, fileLink=${body.fileLink}\n`);

		logLine(`\n--- verdict: PASS (transport-level cloud smoke succeeded) ---\n`);
		logLine(
			"\nNote: this is transport-level proof, not a real gsd-pi session.\n" +
				"gsd-pi would spawn the same node src/server.mjs child and drive the\n" +
				"same stdio JSON-RPC surface. The 7 tools + R020 envelope reachable\n" +
				"above are what a real gsd-pi session would see, with storage on\n" +
				"the S3-compatible cloud backend (MERMAID_RENDERER_BACKEND=oss).\n",
		);
	} catch (err) {
		logLine(`\n--- verdict: FAIL ---\n${err.message}\n`);
	} finally {
		child.stdin.end();
		await new Promise((r) => setTimeout(r, 200));
		if (!child.killed) child.kill("SIGKILL");
		try {
			rmSync(tmpDir, { recursive: true, force: true });
			rmSync(dataDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
}

main().catch((err) => {
	logLine(`[error] ${err.stack || err.message || String(err)}\n`);
});
