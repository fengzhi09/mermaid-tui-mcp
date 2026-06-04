---
estimated_steps: 10
estimated_files: 7
skills_used: []
---

# T01: Build structured stderr JSON logger + persistent counters

Why: R008 requires structured stderr JSON logging with stable fields (ts, level, event, code, id); R010 requires persistent counters in data/counters.json with tmp+rename atomic writes. Both are pure modules with zero S02 dependencies and form the foundation for T03 (render timeout events), T04 (storage write retry events, sweep counter), and T05 (registerTools wrapper counter increment, /health metrics surface). The current log() in src/helpers.mjs:57 uses console.error with a [HH:MM:SS][mermaid-renderer] text prefix — this task replaces it with structured JSON output and migrates the 7 server.mjs call sites. The current code has no persistence layer for metrics — this task adds src/counters.mjs with 6 counter keys, corruption-tolerant load(), single-flight serialized increment(), and tmp+rename atomic write.

Do:
1. Create src/logger.mjs — exports log({level="info", event, code, id, ...rest}) which calls process.stderr.write(JSON.stringify({ts: new Date().toISOString(), level, event, ...(code != null ? {code} : {}), ...(id != null ? {id} : {}), ...rest}) + "\n"). Stable field order: ts, level, event, code, id, ...rest. Required fields: ts, level, event. code and id are omitted (not emitted as null) when null/undefined. process.stderr.write is wrapped in try/catch that swallows EPIPE (consumer disconnected — the renderer is shutting down and the log is best-effort).
2. Create src/counters.mjs — exports Counters class. Constructor takes a root dir string. load() reads <root>/counters.json via readFile; on JSON.parse failure or missing file, populates fresh values = Object.fromEntries(COUNTER_KEYS.map(k => [k, 0])). increment(key) appends to a single-flight promise chain (this._writeChain = this._writeChain.then(...)), bumps this.values[key] (creating the key on first use with default 0), serializes to JSON, writes to <root>/counters.json.tmp via writeFile, then renames tmp → real via rename. snapshot() returns { ...this.values }. Exported const COUNTER_KEYS = ["render_total", "render_errors", "ascii_failures", "storage_write_retries", "sweep_runs", "sweep_removed"]. The mutex is in-process only; multi-process is out of scope (R037).
3. Create tests/unit/logger.test.mjs (6-8 cases). Use vi.spyOn(process.stderr, "write").mockImplementation(() => {}) restored in afterEach (per S01 follow-up "S03 must not pollute unit-test silence"). Assert: log({event: "x"}) writes exactly once; the written bytes are a single line of valid JSON ending with \n; required fields ts/level/event present; ts is a valid ISO 8601 string parseable by new Date(); level defaults to "info"; null/undefined code/id are omitted (not "code": null); extra fields are preserved in stable order; the line is a single line (no embedded newlines even with multi-line strings in extras).
4. Create tests/unit/counters.test.mjs (8-10 cases). Use mkdtemp + rm per S01 pattern. Assert: fresh root → snapshot has all 6 keys at 0; increment("render_total") bumps to 1; Promise.all of 100 increments yields snapshot.render_total === 100 (single-flight mutex); corrupted JSON → load() starts fresh with all keys at 0; missing file → load() starts fresh; <root>/counters.json.tmp is unlinked after increment (use existsSync); a second Counters instance on the same root loads the persisted values; snapshot returns a shallow copy (mutating the snapshot does not affect internal state).
5. Update src/helpers.mjs — replace the local log() body with a re-export from src/logger.mjs (preserves the 6 single-name ^export invariant in src/server.mjs per MEM015 + S01 audit grep). Add a 1-line comment pointing to src/logger.mjs.
6. Update src/server.mjs — migrate all 7 log() call sites to the new structured record API. Each call site gets a single, structured record: log("MERMAID_RENDERER_BACKEND=oss: 'oss' backend is a stub for M002; falling back to LocalFsStorage") → log({level: "warn", event: "backend_stub", backend: "oss"}); log("sweep error:", e) → log({level: "error", event: "sweep_error", error: String(e?.message || e)}); log("mcp stdio connected") → log({event: "mcp_stdio_connected"}); log(`HTTP ${req.method} ${url.pathname} -> ${status}:`, e?.message || e) → log({level: "error", event: "http_error", method: req.method, path: url.pathname, status, error: String(e?.message || e)}); log(`http listening on http://${HTTP_HOST}:${HTTP_PORT}`) → log({event: "http_listening", host: HTTP_HOST, port: HTTP_PORT}); log(`v${VERSION} ready | data: ${DATA} | http: ... | stats:`, storage.stats()) → log({event: "boot", version: VERSION, data: DATA, http: HTTP_ENABLED, stats: storage.stats()}); log(`${sig} received, draining...`) → log({event: "shutdown", signal: sig}). All call sites now use the new structured record; no console.error, no text prefix.
7. Update tests/unit/server-helpers.test.mjs — replace the vi.spyOn(console, "error") with vi.spyOn(process.stderr, "write").mockImplementation(() => {}) in the describe("log") block. Update the test to call log({event: "hello", extra: 42}) and assert the written bytes are a single JSON line with {ts, level: "info", event: "hello", extra: 42}. The other 5 describe blocks (escapeHtml, fileUrlFor, extractSvgBody, httpError, renderView) are unchanged.

Done when: `npm test -- tests/unit/logger.test.mjs tests/unit/counters.test.mjs tests/unit/server-helpers.test.mjs` exits 0; the new logger writes a single JSON line per call to process.stderr.write; the new counters persist to data/counters.json with tmp+rename and survive a new Counters instance on the same root; the 7 server.mjs call sites compile and run; node --check src/logger.mjs src/counters.mjs src/server.mjs src/helpers.mjs exits 0.

## Inputs

- `src/helpers.mjs`
- `src/server.mjs`
- `tests/unit/server-helpers.test.mjs`

## Expected Output

- `src/logger.mjs`
- `src/counters.mjs`
- `tests/unit/logger.test.mjs`
- `tests/unit/counters.test.mjs`
- `src/helpers.mjs`
- `src/server.mjs`
- `tests/unit/server-helpers.test.mjs`

## Verification

npm test -- tests/unit/logger.test.mjs tests/unit/counters.test.mjs tests/unit/server-helpers.test.mjs

## Observability Impact

adds stderr JSON log surface (single line per call, stable field order {ts, level, event, code?, id?, ...rest}); adds data/counters.json persistence with 6 counter keys and tmp+rename atomic write; replaces 7 text-prefixed log() call sites in server.mjs with structured records
