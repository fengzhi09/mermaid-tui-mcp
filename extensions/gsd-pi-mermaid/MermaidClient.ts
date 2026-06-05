// extensions/gsd-pi-mermaid/MermaidClient.ts
//
// Long-lived child-process JSON-RPC client for the mermaid-tui-mcp server.
//
// Why this exists:
//   The default gsd-pi MCP transport (mcp-client extension →
//   @modelcontextprotocol/sdk 1.29.0) double-escapes the `code` arg when
//   relaying a tool call through `mcp_call`, so the mermaid server receives
//   literal `\n` instead of real newlines for multi-line Mermaid source. The
//   Mermaid 11 parser then chokes on the single-line input.
//
//   Direct JSON-RPC over stdio (verified end-to-end against
//   `node src/server.mjs`) preserves real newlines — the parser sees two
//   distinct lines as expected. This file is the minimal client that does
//   that transport by hand, in one place, so the 7 gsd-pi tool wrappers
//   in index.ts are thin pass-throughs.
//
//   No gsd-pi imports — fully testable in isolation via plain Node.

import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

/** JSON-RPC 2.0 request envelope (the shape the mermaid server expects). */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope (the shape the mermaid server emits). */
export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: {
		content: Array<{ type: string; text?: string }>;
		[extra: string]: unknown;
	};
	error?: { code: number; message: string; data?: unknown };
}

export interface CallOptions {
	/** Per-call timeout in ms (default 60_000). */
	timeoutMs?: number;
	/** AbortSignal — caller can cancel the in-flight request. */
	signal?: AbortSignal;
	/** Optional progress callback for streaming partial results. */
	onUpdate?: (partial: JsonRpcResponse) => void;
}

export interface MermaidClientConfig {
	/** Absolute path to the mermaid-tui-mcp `src/server.mjs`. */
	serverPath: string;
	/** Env passed verbatim to the child process (e.g. MERMAID_RENDERER_DATA, MERMAID_OSS_*). */
	env?: Record<string, string>;
	/** Override the node binary used to spawn the server (default: `process.execPath`). */
	nodeBin?: string;
	/** Optional cwd for the child process. */
	cwd?: string;
	/** Initialise-time timeout in ms (default 10_000). */
	initTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (resp: JsonRpcResponse) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
	abortHandler: (() => void) | null;
	method: string;
}

/**
 * Long-lived JSON-RPC client over stdio to a single mermaid-tui-mcp server.
 * Spawns the server lazily on first call; the child process is reused across
 * every tool invocation. Safe to share across gsd-pi tool wrappers.
 */
export class MermaidClient {
	private readonly cfg: MermaidClientConfig;
	private child: ChildProcess | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private initPromise: Promise<void> | null = null;
	private lineBuffer = "";
	private exited = false;
	private readonly exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

	constructor(config: MermaidClientConfig) {
		if (!config || typeof config.serverPath !== "string" || config.serverPath.length === 0) {
			throw new Error("MermaidClient: serverPath is required");
		}
		if (!existsSync(config.serverPath)) {
			throw new Error(`MermaidClient: serverPath not found: ${config.serverPath}`);
		}
		this.cfg = { initTimeoutMs: 10_000, ...config };
	}

	/** Public test seam: is the child process currently alive? */
	get alive(): boolean {
		return this.child !== null && !this.exited;
	}

	/** Spawn the child + send `initialize`. Idempotent. */
	private ensureReady(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this.boot();
		return this.initPromise;
	}

	private async boot(): Promise<void> {
		const nodeBin = this.cfg.nodeBin ?? process.execPath;
		const child = spawn(nodeBin, [this.cfg.serverPath], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...(this.cfg.env ?? {}) },
			cwd: this.cfg.cwd,
		});
		this.child = child;

		// stdout: one JSON-RPC message per line. The mermaid-ascii renderer
		// also writes progress lines ("Parsing line: ...", "Setting arrow
		// from [...] to [...]") to stdout — those are not JSON-RPC, so we
		// silently drop them. If the very first line of stdout is non-JSON
		// we emit a one-shot warning to stderr so a transport regression is
		// visible; otherwise we stay quiet.
		child.stdout?.setEncoding("utf-8");
		child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
		// stderr: structured events from the mermaid server (boot / tool_call).
		// We don't surface these to the LLM by default; they go to host stderr.
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (chunk: string) => {
			for (const line of chunk.split("\n")) {
				if (line.length > 0) process.stderr.write(`[mermaid-direct] ${line}\n`);
			}
		});

		child.on("exit", (code, signal) => {
			this.exited = true;
			for (const handler of this.exitHandlers) handler(code, signal);
			// Reject all in-flight requests so callers don't hang.
			const err = new Error(
				`mermaid server exited (code=${code ?? "null"}, signal=${signal ?? "null"}) before responding`,
			);
			for (const [id, p] of this.pending) {
				if (p.timer) clearTimeout(p.timer);
				if (p.abortHandler) p.signal?.removeEventListener("abort", p.abortHandler);
				p.reject(err);
				this.pending.delete(id);
			}
		});

		child.on("error", (e) => {
			const err = new Error(`mermaid server spawn error: ${e.message}`);
			for (const [, p] of this.pending) p.reject(err);
			this.pending.clear();
		});

		// MCP `initialize` roundtrip. The server returns serverInfo before any
		// tools/call will work. We don't need the response payload — we just
		// need the roundtrip to complete so the server is in the "initialized"
		// state and accepts `tools/call` requests.
		await this.rawCall(
			"initialize",
			{
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "gsd-pi-mermaid", version: "0.1.0" },
			},
			{ timeoutMs: this.cfg.initTimeoutMs, method: "initialize" },
		);
		// Send `notifications/initialized` to mirror MCP's wire shape.
		this.sendNotification("notifications/initialized", {});
	}

	private nonJsonStdoutLines = 0;
	private nonJsonWarningEmitted = false;

	private onStdout(chunk: string): void {
		this.lineBuffer += chunk;
		let nl: number;
		while ((nl = this.lineBuffer.indexOf("\n")) >= 0) {
			const line = this.lineBuffer.slice(0, nl);
			this.lineBuffer = this.lineBuffer.slice(nl + 1);
			if (line.length === 0) continue;
			let msg: JsonRpcResponse;
			try {
				msg = JSON.parse(line);
			} catch {
				// Non-JSON line on stdout. The mermaid-ascii renderer emits
				// "Parsing line: ..." progress messages on stdout as a
				// side-effect of the rendering pipeline — these are not
				// JSON-RPC and not errors. Silently drop them. Emit a
				// one-shot stderr warning only if the line is suspicious
				// (doesn't start with a known renderer-progress prefix), so
				// genuine transport regressions are still visible.
				this.nonJsonStdoutLines += 1;
				if (
					!this.nonJsonWarningEmitted &&
					!/^(Parsing line:|Parsing remaining text|Setting arrow from|Generating SVG)/.test(line)
				) {
					this.nonJsonWarningEmitted = true;
					process.stderr.write(
						`[mermaid-direct] non-JSON line on stdout (${this.nonJsonStdoutLines}+ so far): ${line.slice(0, 200)}\n`,
					);
				}
				continue;
			}
			if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue;
			const p = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			if (p.timer) clearTimeout(p.timer);
			if (p.abortHandler) p.signal?.removeEventListener("abort", p.abortHandler);
			if (msg.error) {
				p.reject(new Error(`mermaid server returned error ${msg.error.code}: ${msg.error.message}`));
			} else {
				p.resolve(msg);
			}
		}
	}

	private sendNotification(method: string, params: Record<string, unknown>): void {
		if (!this.child?.stdin?.writable) return;
		const envelope = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(JSON.stringify(envelope) + "\n");
	}

	private async rawCall(
		method: string,
		params: Record<string, unknown>,
		opts: { timeoutMs: number; method: string; signal?: AbortSignal },
	): Promise<JsonRpcResponse> {
		if (!this.child?.stdin?.writable) {
			throw new Error("mermaid server stdin is not writable — child not running?");
		}
		const id = this.nextId++;
		const envelope: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const line = JSON.stringify(envelope) + "\n";

		return new Promise<JsonRpcResponse>((resolve, reject) => {
			const timer =
				opts.timeoutMs > 0
					? setTimeout(() => {
							if (this.pending.has(id)) {
								this.pending.delete(id);
								if (pending.abortHandler) opts.signal?.removeEventListener("abort", pending.abortHandler);
								reject(new Error(`mermaid server call timed out after ${opts.timeoutMs}ms (method=${method})`));
							}
						}, opts.timeoutMs)
					: null;

			const pending: PendingRequest = {
				resolve,
				reject,
				timer,
				abortHandler: null,
				method,
			};

			if (opts.signal) {
				if (opts.signal.aborted) {
					if (timer) clearTimeout(timer);
					reject(new Error(`aborted before method=${method} could be sent`));
					return;
				}
				pending.abortHandler = () => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						if (timer) clearTimeout(timer);
						reject(new Error(`aborted while waiting for method=${method}`));
					}
				};
				opts.signal.addEventListener("abort", pending.abortHandler, { once: true });
			}

			this.pending.set(id, pending);
			this.child!.stdin!.write(line, (err) => {
				if (err) {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						if (timer) clearTimeout(timer);
						if (pending.abortHandler) opts.signal?.removeEventListener("abort", pending.abortHandler);
						reject(new Error(`stdin write failed for method=${method}: ${err.message}`));
					}
				}
			});
		});
	}

	/** Public: call a mermaid tool by name. Returns the raw JSON-RPC response. */
	async callTool(
		toolName: string,
		args: Record<string, unknown>,
		opts: CallOptions = {},
	): Promise<JsonRpcResponse> {
		await this.ensureReady();
		return this.rawCall(
			"tools/call",
			{ name: toolName, arguments: args },
			{
				timeoutMs: opts.timeoutMs ?? 60_000,
				method: toolName,
				signal: opts.signal,
			},
		);
	}

	/** Public: list the server's tools (used by the extension's /tools handler). */
	async listTools(opts: CallOptions = {}): Promise<JsonRpcResponse> {
		await this.ensureReady();
		return this.rawCall("tools/list", {}, { timeoutMs: opts.timeoutMs ?? 10_000, method: "tools/list" });
	}

	/** Best-effort shutdown. Safe to call multiple times. */
	async close(): Promise<void> {
		if (!this.child || this.exited) return;
		const child = this.child;
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			this.exitHandlers.push(finish);
			child.once("exit", finish);
			try {
				child.stdin?.end();
			} catch {
				/* ignore */
			}
			setTimeout(() => {
				if (!this.exited) {
					try {
						child.kill("SIGTERM");
					} catch {
						/* ignore */
					}
				}
				setTimeout(() => {
					if (!this.exited) {
						try {
							child.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}
				}, 800).unref();
			}, 50).unref();
		});
	}
}

/** Resolve the default server path relative to a project root. */
export function defaultServerPath(projectRoot: string): string {
	return resolvePath(projectRoot, "src", "server.mjs");
}
