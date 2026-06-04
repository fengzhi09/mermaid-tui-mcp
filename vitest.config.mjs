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

export default defineConfig({
	test: {
		testTimeout: 30_000,
		include: ["tests/**/*.test.mjs"],
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
