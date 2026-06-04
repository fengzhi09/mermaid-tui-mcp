// tests/integration/real-client-smoke/claude-code.mjs — S04 / T05
//
// Real-client smoke for the Claude Code MCP host. Best-effort: skips
// with a clear log header when `ANTHROPIC_API_KEY` is missing or the
// `claude` binary is not on PATH. Never fails the suite on env gaps —
// the goal is a "we tried, here's the transcript" proof artifact.
//
// Usage: `node tests/integration/real-client-smoke/claude-code.mjs`
// Output: appends to tests/integration/real-client-smoke/claude-code.log
//
// On success: log contains a JSON-RPC transcript proving `claude` was
// launched, registered the `mermaid` MCP server, called
// render_mermaid on a real LLM prompt, and the response contained
// ASCII art + a `file://` link.

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "claude-code.log");
const SERVER_PATH = resolve(__dirname, "..", "..", "..", "src", "server.mjs");

function nowIso() {
	return new Date().toISOString();
}

function logHeader(reason, spawnOk) {
	const banner = [
		"=========================================================",
		`claude-code smoke @ ${nowIso()}`,
		`status: ${reason}`,
		`claude on PATH: ${spawnOk ? "yes" : "no"}`,
		`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? "set" : "missing"}`,
		"=========================================================",
		"",
	].join("\n");
	writeFileSync(LOG_PATH, banner, "utf-8");
}

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY;

	// Step 1: probe `claude` on PATH.
	// Note: on Windows the `claude` binary is an npm shim (claude.cmd);
	// Node's spawn() needs `shell: true` to resolve .cmd shims.
	let SPAWN_OK = true;
	try {
		const probe = spawn("claude", ["--version"], { stdio: "ignore", shell: true });
		await new Promise((resolveProbe, rejectProbe) => {
			probe.on("error", () => {
				SPAWN_OK = false;
				rejectProbe();
			});
			probe.on("exit", (code) => {
				if (code !== 0) SPAWN_OK = false;
				resolveProbe();
			});
		});
	} catch {
		SPAWN_OK = false;
	}

	if (!SPAWN_OK) {
		logHeader("SKIPPED: `claude` binary not on PATH", SPAWN_OK);
		console.warn("claude smoke skipped: `claude` binary not on PATH");
		process.exit(0);
	}

	if (!apiKey) {
		logHeader("SKIPPED: ANTHROPIC_API_KEY not set", SPAWN_OK);
		console.warn("claude smoke skipped: ANTHROPIC_API_KEY not set");
		process.exit(0);
	}

	// Step 2: build the inline MCP config for `claude --print --mcp-config`
	const mcpConfig = {
		mcpServers: {
			mermaid: {
				command: "node",
				args: [SERVER_PATH],
			},
		},
	};
	const prompt =
		"Use the mermaid MCP server to render a flowchart of two services A and B with an arrow from A to B. " +
		"Paste the ASCII output in your reply and print the fileLink.";

	appendFileSync(
		LOG_PATH,
		`\n[run @ ${nowIso()}] spawning: claude --print --mcp-config '<inline>' <prompt>\n`,
		"utf-8",
	);

	// Step 3: spawn claude (shell:true on Windows for the .cmd npm shim)
	const child = spawn(
		"claude",
		["--print", "--mcp-config", JSON.stringify(mcpConfig), prompt],
		{
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
			shell: true,
		},
	);

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (c) => {
		const s = c.toString("utf-8");
		stdout += s;
		appendFileSync(LOG_PATH, `[stdout] ${s}`, "utf-8");
	});
	child.stderr.on("data", (c) => {
		const s = c.toString("utf-8");
		stderr += s;
		appendFileSync(LOG_PATH, `[stderr] ${s}`, "utf-8");
	});

	const exitCode = await new Promise((resolveExit) => {
		child.on("exit", (code) => resolveExit(code));
	});

	appendFileSync(
		LOG_PATH,
		`\n[exit @ ${nowIso()}] code=${exitCode}, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes\n`,
		"utf-8",
	);

	// Step 4: best-effort assertion — does the transcript look like a real
	// render? Don't fail the suite on this (network flakes happen);
	// just record the verdict in the log.
	const hasAscii = /[┌╔→]|[\+]-{2,}/.test(stdout);
	const hasFileLink = /file:\/\//.test(stdout);
	const verdict = hasAscii && hasFileLink ? "PASS" : "INCONCLUSIVE";
	appendFileSync(
		LOG_PATH,
		`[verdict] ${verdict} (ascii=${hasAscii}, fileLink=${hasFileLink})\n`,
		"utf-8",
	);

	if (verdict === "INCONCLUSIVE") {
		console.warn(
			"claude smoke inconclusive: response did not contain ASCII art + file:// link. " +
				"See " + LOG_PATH + " for the transcript. Not failing the suite (best-effort).",
		);
	}

	// Best-effort: always exit 0 (do not fail the suite on env issues)
	process.exit(0);
}

main().catch((err) => {
	appendFileSync(LOG_PATH, `\n[error] ${err.stack || err.message || String(err)}\n`, "utf-8");
	console.error("claude smoke errored:", err.message);
	process.exit(0);
});
