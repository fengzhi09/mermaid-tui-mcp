// vitest.config.mjs — M001 test harness configuration.
//
// Matches package.json "type": "module" (ESM). Coverage excludes
// src/server.mjs because its mainline bootstrap (creating Storage, calling
// `await storage.load()`, connecting the stdio MCP transport) only runs in
// a child process spawned by integration tests; vitest's v8 coverage does
// not track code running in a separate process. The unit-testable helpers
// are exported from src/server.mjs (per T01) and imported directly by
// unit tests, so they are picked up by coverage.

import { defineConfig } from "vitest/config";

// S01 T04: fileParallelism is disabled because three integration
// tests dynamically allocate TCP ports on 127.0.0.1 and bind
// `net.createServer()` blockers. With the default parallel test
// runner, two tests can race on overlapping port ranges — one
// test's `bindBlocker(base, base+1, base+2)` may collide with
// another test's `MERMAID_RENDERER_PORT=base+1`, causing the
// second server to fail to bind and the test to time out on
// `waitForHealth`. The integration tests are short (the whole
// suite is <60s sequentially) and the unit tests are not CPU
// bound, so sequential file execution is the right default. See
// M003/S01/T04 task summary for the failure trace.
export default defineConfig({
	test: {
		testTimeout: 30_000,
		include: ["tests/**/*.test.mjs"],
		fileParallelism: false,
	},
	coverage: {
		provider: "v8",
		reporter: ["text", "lcov"],
		include: ["src/**/*.mjs"],
		exclude: ["src/server.mjs"],
		thresholds: {
			lines: 80,
		},
	},
});
