// tests/unit/server-helpers.test.mjs — unit tests for src/helpers.mjs.
//
// The six pure helpers (escapeHtml, fileUrlFor, extractSvgBody, httpError,
// renderView, log) were extracted from src/server.mjs in T02 so they can
// be unit-tested in isolation. Importing server.mjs would run its mainline
// bootstrap (Storage instantiation, `await storage.load()`, stdio MCP
// connect) and pollute the repo with a `data/` directory — out of scope
// for a unit test, and that's what the integration tests in T03 cover.
//
// S02 T01 adds `buildStorageFromEnv` to the helper surface. It's a pure
// function of its inputs (no I/O, no `.load()`) so the tests pass a
// plain object literal as `env` and assert on the returned instance
// shape without touching the network or disk. The fixture for the
// LocalFsStorage assertion is the same mkdtemp pattern the storage
// tests use (so the constructor's `mkdir -p` on the real data dir is
// exercised by the next .load() call — these tests deliberately do
// not call .load(), they only assert on construction shape).

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildStorageFromEnv, escapeHtml, extractSvgBody, fileUrlFor, httpError, log, renderView } from "../../src/helpers.mjs";
import { LocalFsStorage } from "../../src/storage/LocalFsStorage.mjs";
import { OssEnvInvalidError, OssStorage } from "../../src/storage/OssStorage.mjs";
import { DegradableStorage } from "../../src/storage/DegradableStorage.mjs";
import { Counters } from "../../src/counters.mjs";

describe("escapeHtml", () => {
	it("escapes &, <, >, \", and '", () => {
		expect(escapeHtml("a&b")).toBe("a&amp;b");
		expect(escapeHtml("<x>")).toBe("&lt;x&gt;");
		expect(escapeHtml(`"q"`)).toBe("&quot;q&quot;");
		expect(escapeHtml("it's")).toBe("it&#39;s");
	});

	it("returns an unchanged string for inputs that need no escaping", () => {
		expect(escapeHtml("hello world")).toBe("hello world");
		expect(escapeHtml("")).toBe("");
	});
});

describe("fileUrlFor", () => {
	it("produces file:///abs for posix absolute paths", () => {
		expect(fileUrlFor("/Users/foo/bar.svg")).toBe("file:///Users/foo/bar.svg");
		expect(fileUrlFor("/var/log/x.log")).toBe("file:///var/log/x.log");
	});

	it("converts windows backslashes to forward slashes and prefixes with file:///", () => {
		expect(fileUrlFor("C:\\foo\\bar.svg")).toBe("file:///C:/foo/bar.svg");
		expect(fileUrlFor("D:\\nested\\path\\file.txt")).toBe("file:///D:/nested/path/file.txt");
	});
});

describe("extractSvgBody", () => {
	it("returns the inner content of a <svg>...</svg> block", () => {
		expect(extractSvgBody("<svg id=x>inner</svg>")).toBe("inner");
		expect(extractSvgBody("<svg viewBox=\"0 0 10 10\"><g><rect/></g></svg>")).toBe("<g><rect/></g>");
	});

	it("returns '' for input with no svg", () => {
		expect(extractSvgBody("hello world")).toBe("");
		expect(extractSvgBody("<div>nope</div>")).toBe("");
	});
});

describe("httpError", () => {
	it("returns an Error with .status and .message set", () => {
		const e = httpError(404, "not found");
		expect(e).toBeInstanceOf(Error);
		expect(e.status).toBe(404);
		expect(e.message).toBe("not found");
	});

	it("preserves arbitrary status codes (not just 4xx)", () => {
		expect(httpError(500, "boom").status).toBe(500);
		expect(httpError(418, "teapot").status).toBe(418);
	});
});

describe("renderView", () => {
	it("substitutes the {{ID}}, {{CREATED_AT}}, {{SVG_BODY}} placeholders in public/view.html", async () => {
		const id = "mTest1";
		const entry = {
			code: "graph TD\n  A-->B",
			createdAt: 1_700_000_000_000,
			pinned: false,
			lastAccessedAt: 1_700_000_000_000,
			sourceLength: 13,
		};
		const svg = "<svg id=mermaid-svg>body</svg>";
		const html = await renderView(id, entry, svg, /*withPinButton=*/true);

		expect(html).toContain(escapeHtml(id));
		expect(html).toContain(new Date(entry.createdAt).toISOString());
		expect(html).toContain("body");

		// the raw placeholders are gone (rendered view never leaks the template tokens)
		expect(html).not.toContain("{{ID}}");
		expect(html).not.toContain("{{CREATED_AT}}");
		expect(html).not.toContain("{{SVG_BODY}}");
	});

	it("html-escapes the id in title/span and JSON-escapes it inside the inline <script>", async () => {
		const id = "<script>alert(1)</script>";
		const entry = {
			code: "code&with<bad>\"chars'",
			createdAt: 1_700_000_000_000,
			pinned: true,
			lastAccessedAt: 1_700_000_000_000,
			sourceLength: 21,
		};
		const html = await renderView(id, entry, "<svg></svg>", false);

		// html-escaped id appears (in <title> and <span class="id"> via {{ID}})
		expect(html).toContain(escapeHtml(id));
		// json-escaped id appears inside the inline <script> (via {{ID_JSON}})
		expect(html).toContain(JSON.stringify(id));
		// html-escaped code appears (in <pre> via {{CODE}})
		expect(html).toContain(escapeHtml(entry.code));
		// raw unescaped form must not appear in the html context. The S02
		// template puts the title prefix as {{TITLE}} (empty for this entry)
		// so the rendered <title> degrades to " · Mermaid <id>". The escaped
		// id must still land in the <title> element AND the <span class="id">.
		expect(html).toMatch(/<title>\s*·\s*Mermaid &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
		expect(html).toMatch(/<span class="id">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
		// The h1.title slot is also empty (entry.title is unset).
		expect(html).toMatch(/<h1 class="diagram-title" id="diagram-title"><\/h1>/);
		// {{TITLE_JSON}} resolves to "" when no title.
		expect(html).toContain('const TITLE = "";');
	});
});

describe("log", () => {
	it("writes a single JSON line to process.stderr with required fields (R008)", () => {
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		try {
			log({ event: "hello", extra: 42 });
			expect(spy).toHaveBeenCalledTimes(1);
			const written = spy.mock.calls[0][0];
			const line = typeof written === "string" ? written : Buffer.is(written) ? written.toString("utf-8") : String(written);
			// Single line ending in newline.
			expect(line.endsWith("\n")).toBe(true);
			// No embedded newlines in the body.
			expect(line.slice(0, -1).includes("\n")).toBe(false);
			// Parses as JSON; required fields are present and match the call.
			const obj = JSON.parse(line.replace(/\n$/, ""));
			expect(obj).toMatchObject({ level: "info", event: "hello", extra: 42 });
			expect(obj).toHaveProperty("ts");
			expect(new Date(obj.ts).toISOString()).toBe(obj.ts);
			// Stable field order: ts, level, event come first.
			const keys = Object.keys(obj);
			expect(keys[0]).toBe("ts");
			expect(keys[1]).toBe("level");
			expect(keys[2]).toBe("event");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("buildStorageFromEnv (S02 T01 + D018)", () => {
	let tmpDir;
	afterEach(async () => { if (tmpDir) { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} tmpDir = null; } });
	// S02 T01 contract: buildStorageFromEnv(env, opts) returns the right
	// StorageBackend for the env. D018: when BACKEND=oss, it now wraps
	// OssStorage in DegradableStorage(primary=OssStorage, fallback=LocalFsStorage)
	// so runtime S3 failures degrade to local instead of hard-failing every call.
	const REQUIRED_OSS_VARS = [
		"MERMAID_OSS_ENDPOINT",
		"MERMAID_OSS_REGION",
		"MERMAID_OSS_ACCESS_KEY_ID",
		"MERMAID_OSS_SECRET_ACCESS_KEY",
		"MERMAID_OSS_BUCKET",
	];

	it("with no BACKEND returns plain LocalFsStorage (no wrap)", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "bsfe-local-"));
		const storage = buildStorageFromEnv({ /* no BACKEND */ }, { dataDir: tmpDir });
		expect(storage).toBeInstanceOf(LocalFsStorage);
		expect(storage).not.toBeInstanceOf(DegradableStorage);
		expect(storage.root).toBe(tmpDir);
	});

	it("with BACKEND=oss + valid env returns DegradableStorage(primary=OssStorage, fallback=LocalFsStorage)", () => {
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			MERMAID_OSS_BUCKET: "mermaid-bucket",
		};
		const storage = buildStorageFromEnv(env);
		expect(storage).toBeInstanceOf(DegradableStorage);
		expect(storage).not.toBeInstanceOf(OssStorage); // wrapped, not naked
		expect(storage.primary).toBeInstanceOf(OssStorage);
		expect(storage.fallback).toBeInstanceOf(LocalFsStorage);
		// OssStorage 字段在 primary 上 (D018 wrapper 不持有这些).
		expect(storage.primary.root).toBe("mermaid-bucket");
		expect(storage.primary.bucket).toBe("mermaid-bucket");
		expect(storage.primary.client).toBeTruthy();
		expect(typeof storage.primary.client.send).toBe("function");
		// M003/S03/T03 决定: root 走 fallback, 让运维在降级时看到"实际数据
		// 在本地"而不是被 bucket 名误导. 这里没传 dataDir, fallback 的 root
		// 是空串 (env.MERMAID_RENDERER_DATA 也是空). 原 bucket 名仍可
		// 通过 health().primary_root 看到.
		expect(storage.root).toBe("");
		// health() 走 wrapper, primary_root / fallback_root 双向都暴露.
		expect(storage.health().degraded).toBe(false);
		expect(storage.health().breaker_state).toBe("closed");
		expect(storage.health().consecutive_failures).toBe(0);
		expect(storage.health().failure_threshold).toBe(3);
		expect(storage.health().primary_root).toBe("mermaid-bucket");
		expect(storage.health().fallback_root).toBe("");
	});

	it("with BACKEND=oss + missing MERMAID_OSS_BUCKET throws OssEnvInvalidError", () => {
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			// MERMAID_OSS_BUCKET intentionally omitted
		};
		const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => {});
		expect(() => buildStorageFromEnv(env)).toThrow(OssEnvInvalidError);
		try { buildStorageFromEnv(env); } catch (err) {
			expect(err).toBeInstanceOf(OssEnvInvalidError);
			expect(err.missing).toEqual(["MERMAID_OSS_BUCKET"]);
			expect(err.code).toBe(-32006);
		}
		expect(spy).toHaveBeenCalled();
	});

	it("respects opts.counters / opts.logger pass-through to both primary + fallback", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "bsfe-counters-"));
		const counters = new Counters(tmpDir);
		await counters.load();
		const logger = { log: vi.fn() };
		// local 路径: counters/logger 透传 (老契约, 不变).
		const storage = buildStorageFromEnv({ /* no BACKEND */ }, { dataDir: tmpDir, counters, logger });
		expect(storage.counters).toBe(counters);
		expect(storage.logger).toBe(logger);

		// OSS 路径: counters/logger 透传到 primary + fallback 两侧 (D018 wrapper 自己不持有).
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			MERMAID_OSS_BUCKET: "mermaid-bucket",
		};
		const wrapped = buildStorageFromEnv(env, { counters, logger });
		expect(wrapped.primary.counters).toBe(counters);
		expect(wrapped.primary.logger).toBe(logger);
		expect(wrapped.fallback.counters).toBe(counters);
		expect(wrapped.fallback.logger).toBe(logger);
	});

	it("with BACKEND=oss + createBucket:true passes it through to primary OssStorage", () => {
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			MERMAID_OSS_BUCKET: "mermaid-bucket",
		};
		const storage = buildStorageFromEnv(env, { createBucket: true });
		expect(storage).toBeInstanceOf(DegradableStorage);
		expect(storage.primary.createBucket).toBe(true);

		const storageDefault = buildStorageFromEnv(env);
		expect(storageDefault.primary.createBucket).toBe(false);
	});

	it("respects MERMAID_DEGRADE_THRESHOLD env var", () => {
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			MERMAID_OSS_BUCKET: "mermaid-bucket",
			MERMAID_DEGRADE_THRESHOLD: "7",
		};
		const storage = buildStorageFromEnv(env);
		expect(storage.health().failure_threshold).toBe(7);
	});

	it("S03/T03: respects MERMAID_DEGRADE_HALF_OPEN_AFTER_MS env var", () => {
		const env = {
			MERMAID_RENDERER_BACKEND: "oss",
			MERMAID_OSS_ENDPOINT: "http://127.0.0.1:9000",
			MERMAID_OSS_REGION: "us-east-1",
			MERMAID_OSS_ACCESS_KEY_ID: "AKID_TEST",
			MERMAID_OSS_SECRET_ACCESS_KEY: "SECRET_TEST",
			MERMAID_OSS_BUCKET: "mermaid-bucket",
			MERMAID_DEGRADE_HALF_OPEN_AFTER_MS: "5000",
		};
		const storage = buildStorageFromEnv(env);
		expect(storage.health().half_open_after_ms).toBe(5000);
		// primary 侧的 OssStorage.breaker 也被覆盖 (wrapper 在 constructor
		// 里把 halfOpenAfterMs 应用到 primary.breaker.halfOpenAfterMs).
		expect(storage.primary.breaker.halfOpenAfterMs).toBe(5000);
	});
});
