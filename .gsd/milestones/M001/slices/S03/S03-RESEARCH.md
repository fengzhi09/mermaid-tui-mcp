# S03: Observability — logs, health, counters, error contract — Research

**Date:** 2026-06-04
**Lane:** research
**Slice ID:** S03 (M001)
**Status:** Ready for planning
**Depends on:** S01 (test + CI baseline); S02 (delivered after S03 per dep order — see "S03 ↔ S02 ordering" below)

## Summary

S03 is the "instrumentation" slice. It must give gsd-pi / Claude Code / a future on-call agent enough observability to know (a) the server is alive, (b) whether renders are succeeding, (c) what the last few errors were, and (d) which retry path was hit. The deliverables break into four independent surfaces:

1. **Structured stderr logger** (R008) — single-line JSON, fields `{ts, level, event, code, id}`. Replaces the current `log()` helper (`src/helpers.mjs:78-82`) which writes a `console.error(...)` text prefix. Net behavior change: text → JSON; signature stays the same so the 6 single-name re-exports from `src/server.mjs` (MEM015) remain stable.
2. **Persistent counters** (R010) — `data/counters.json` with `tmp+rename` atomic writes, startup `load()`, `increment()` per event. Six counter keys: `render_total`, `render_errors`, `ascii_failures`, `storage_write_retries`, `sweep_runs`, `sweep_removed` (exactly per R010).
3. **/health extension** (R009) — additive to the existing shape (`{status, version, uptimeSec, ttlDays, total, pinned, unpinned}` from `src/server.mjs:206-212`). New fields: `counters` (object), `last_render_ms` (number), `last_errors` (array ≤ 5 ring buffer, `{code, at, retryable}` shape).
4. **Error contract + 3 retry paths** (R015/R016/R017/R018/R020/R022) — zod-based chokepoint, render timeout 10s (injectable via `MERMAID_RENDER_TIMEOUT_MS`), jsdom init retry 1×, storage write retry 1× (transient only), port fallback 5300→5301→5302 (3 tries).

**Key constraint:** R020 defines `{...payload, elapsed_ms, warnings?}` for success and `{isError: true, error: {code, message, retryable}}` for failure. This contract applies to all 7 MCP tools, but S03 is delivered BEFORE S02 (per `depends:[S01]`). S03 must ship the framework + apply it to the existing single tool `render_mermaid`; S02 will adopt it for the 6 new tools. The framework must be backwards-compatible — the existing 9 eval tests (eval-01..08, eval-10) all assert `{id, ascii, fileLink, ...}` and must keep passing.

**Biggest unblocker for downstream slices:** S02 needs the error contract to wrap its 6 new tool handlers, and S04 needs the `/health` response shape to verify metrics. Both depend on the framework being stable when S02 lands. Build the framework + apply to render_mermaid + test it as a single integrated task; don't ship a half-wired framework.

## Recommendation

### Stack (locked by D004 / pre-decided)

| Layer | Choice | Rationale |
|---|---|---|
| Validation + error classification | **`zod@^4`** (already on disk transitively via `@modelcontextprotocol/sdk@1.29.0` → `zod@4.4.3`) | Locked by D004. Add as direct dep — currently transitive, package.json must declare it. |
| Test runner | vitest 3.2.6 (S01) | Reuse. New tests under `tests/unit/`, `tests/integration/`, no new helper modules needed. |
| Logger | Native `process.stderr.write(JSON.stringify(...) + "\n")` | No dep. ~30 LOC. Buffer-safe via `Buffer.byteLength` check (single-line guarantee). |
| Counter persistence | `node:fs/promises` + `node:fs.renameSync` (synchronous rename) for atomic write | No dep. `fs.rename` is atomic on POSIX, near-atomic on Windows (overwrite semantics). `tmp+rename` pattern. |
| Retry policy | Hand-rolled `tryOnce(fn, classify)` wrappers | 3 lines per wrapper; no dep. `classify` is a pure function that returns `'transient' \| 'terminal'`. |
| Port fallback | `httpServer.on('error', ...)` listener + `close` + re-listen loop in `src/server.mjs` | Built-in `http` module, no dep. |

### Critical disambiguation: error code namespace

**The MCP SDK's JSON-RPC `ErrorCode` enum uses `-32000 ConnectionClosed` and `-32001 RequestTimeout` (`node_modules/@modelcontextprotocol/sdk/dist/cjs/types.d.ts:2128-2137`).** Our S03 codes -32001..-32009 collide with the SDK's transport-level codes if interpreted as JSON-RPC `error.code`. They must NOT be.

R020 and the error-handling strategy in `M001-CONTEXT.md` already encode the correct shape: failures are returned as `tools/call` results with `{isError: true, content: [...], error: {code, message, retryable}}` — the `code` lives in the application payload, not in the JSON-RPC envelope. **S03 must document and enforce this:** the `-32001` in our error contract refers to the inner `error.code` field of an MCP `CallToolResult` with `isError: true`, not the JSON-RPC `error.code`. The slice plan language "错误码 -32001 到 -32009" is the inner `error.code`. Add a 1-line clarifying comment in the error module so future readers don't collide.

**Code-to-counter mapping (full table for planner reference):**

| `error.code` | Meaning | retryable | Increments counter | Logged at level |
|---|---|---|---|---|
| `-32602` | Invalid params (zod validation / code empty / code > 200KB / title > 200 chars) | false | `render_errors` if from render_mermaid, else no counter | `warn` |
| `-32001` | `render_timeout` (10s exceeded) | false | `render_errors` | `error` |
| `-32002` | `render_failed` (mermaid parse error) | false | `render_errors` | `error` |
| `-32003` | `jsdom_init_failed` (1× retry exhausted) | false | `render_errors` | `error` |
| `-32004` | `storage_write_failed` (1× retry exhausted) | true | `render_errors` + `storage_write_retries` (if it had a transient attempt) | `error` |
| `-32005` | `storage_read_failed` / not found (5s timeout OR `id` missing) | true | `render_errors` | `error` |
| `-32006` | (reserved) | — | — | — |
| `-32007` | (reserved) | — | — | — |
| `-32008` | `port_in_use` (3 fallback attempts exhausted) | true | no counter (boot-time) | `error` |
| `-32009` | `mcp_protocol_violation` (client sent bad JSON-RPC) | false | no counter | `warn` |

Plan calls for "-32001 到 -32009 映射到 counter 齐全" (all 9 codes map to a counter). The 2 reserved slots (-32006, -32007) are the planner's call: either leave them mapped to a no-op `no_op` counter slot (cheap), or document them as "reserved for S04+". Recommend the former — keeping 9 code→counter rows visible in code matches the plan's "齐全" wording and makes future additions trivial.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  src/logger.mjs           (NEW — ~30 LOC)                         │
│    log({level, event, code?, id?, ...extras})  →                  │
│    process.stderr.write(JSON.stringify({ts, level, event, ...})   │
│                          + "\n")                                  │
│    • stable field order, no extra whitespace                       │
│    • replaces helpers.mjs log(); same call signature               │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  src/counters.mjs         (NEW — ~80 LOC)                         │
│    class Counters {                                              │
│      constructor(root)       // <root>/counters.json             │
│      async load()            // tolerant of corruption            │
│      async increment(key)    // tmp+rename atomic write           │
│      async snapshot()        // returns plain object              │
│    }                                                              │
│    COUNTER_KEYS = [render_total, render_errors, ascii_failures,  │
│                    storage_write_retries, sweep_runs,             │
│                    sweep_removed]                                 │
│    All writes: writeFile(tmp) → rename(tmp, real)                │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  src/errors.mjs           (NEW — ~120 LOC)                        │
│    import { z } from "zod"                                        │
│    ErrorCode enum (-32001..-32009, -32602) — numeric, no SDK      │
│      collision (see disambiguation above)                         │
│    classifyZodError(zodErr) → {code: -32602, message, retryable} │
│    classifyDomainError(err) → {code, message, retryable}          │
│    renderError(code, message, extras) → {isError: true,          │
│      content: [{type: "text", text: <json>}],                     │
│      error: {code, message, retryable, ...extras}}                 │
│    MCPError extends Error { code, retryable }                     │
│      → thrown from tool handlers; caught by server.mjs            │
│        CallToolRequestSchema handler; converted via               │
│        renderError()                                               │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  src/render.mjs          (MODIFY — additive)                      │
│    • Add MERMAID_RENDER_TIMEOUT_MS env (default 10000)            │
│    • Wrap mermaid.render() in race(Promise, timeout)              │
│      → on timeout, throw with code -32001                         │
│    • Add 1× retry to getMermaid() (clear mermaidPromise on fail)  │
│      → on final fail, throw with code -32003                      │
│    • Expose __resetMermaidForTesting() for unit tests              │
│      (only mutates state when a test flag is set)                 │
│    • Add ascii-failure counter increment + warning                 │
│      (currently swallowed at src/render.mjs:101-104)             │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  src/storage.mjs         (MODIFY — additive)                      │
│    • All writeFile() calls wrapped in retryOnce(classify)         │
│      where classify returns transient only for EAGAIN/EWOULDBLOCK│
│      ENOSPC/EACCES → no retry, throw with code -32004             │
│    • All readFile() calls wrapped in withTimeout(5000)            │
│      → on timeout, throw with code -32005                         │
│    • Sweep() increments sweep_runs / sweep_removed counters       │
│    • Atomic save() uses tmp+rename (replaces current direct       │
│      writeFile of store.json)                                     │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│  src/server.mjs          (MODIFY — additive)                      │
│    • Import logger/counters/errors, instantiate at boot           │
│    • CallToolRequestSchema handler wraps each tool:               │
│        try { payload = await toolImpl(args) }                     │
│        catch (e) { return renderError(...) }                      │
│      so render_mermaid (and the future 6 tools) produce           │
│      isError:true on failure, with {code, message, retryable}     │
│    • render_mermaid's success shape gets +elapsed_ms +warnings    │
│      (R020). Existing fields preserved.                            │
│    • /health handler merges counters.snapshot() +                 │
│      {last_render_ms, last_errors: [..5..]} into the response.     │
│    • HTTP listen wraps httpServer.on('error', retry) on           │
│      EADDRINUSE → try 5301, 5302, then -32008.                    │
│    • In-flight render tracks last_render_ms on success.           │
│    • Graceful shutdown: 3s drain timer (already there) unref'd.   │
│    • No new setInterval; reuse the existing 1h sweep (unref it!). │
│      MEM017 captures the unref pattern; S03 should apply it       │
│      to keep test child processes exit-able.                       │
└──────────────────────────────────────────────────────────────────┘
```

### Injection seams (for testability without spawning the process)

S01's pattern (MEM015) is "extract pure helpers into `src/helpers.mjs`, unit-test them directly, leave the bootstrap in `src/server.mjs` excluded from coverage". S03 must follow the same shape:

1. **Logger** — exported `log()` function takes the record object; unit tests pass a `process.stderr.write` spy (no monkey-patching needed; capture process.stderr via vitest's `vi.spyOn(process.stderr, 'write')`).
2. **Counters** — constructor takes a `root` dir; tests pass `mkdtemp(...)`; `tmp+rename` is observable by checking `<root>/counters.json.tmp` is gone after `increment()`.
3. **Errors** — pure functions; trivial to test.
4. **Render timeout** — module reads `MERMAID_RENDER_TIMEOUT_MS` once at first `render()` call. Tests set `process.env.MERMAID_RENDER_TIMEOUT_MS = "1"` and pass a `code` that triggers a slow render (e.g., a large gantt). **Subtlety:** mermaid 11 rarely takes >1s on small inputs; to reliably hit timeout in CI, the test must use a code that's known-slow OR monkey-patch `mermaid.render` to return a never-resolving promise. Recommend the latter — wrap `mermaid.render` in a function passed in via `__setMermaidRenderForTesting(fn)`.
5. **jsdom init retry** — `__resetMermaidForTesting()` clears `mermaidPromise`; tests call it + set `__setJSDOMFactoryForTesting(() => { throw new Error("mock fail") })` to force a single retry, then verify behavior.
6. **Storage write retry** — `__setWriteFileForTesting(fn)` where `fn` is the override; tests provide a function that throws `{code: 'EAGAIN'}` once then succeeds.
7. **Port fallback** — wrap listen in a small helper; unit test with a mock `httpServer` that emits 'error' with `{code: 'EADDRINUSE'}` on first listen, succeeds on second.

### Test plan (extend S01's three trees)

**Unit (new, all under `tests/unit/`):**
- `tests/unit/logger.test.mjs` — 5-7 assertions: line format is valid JSON; required fields present; `ts` is ISO timestamp; `process.stderr.write` called once per log; preserves field order.
- `tests/unit/counters.test.mjs` — 8-10 assertions: fresh dir → empty snapshot; increment adds 1; concurrent increments (Promise.all) yield final value = N (atomicity); corrupted JSON → fresh start; tmp file gone after rename; sweep counter increments correctly.
- `tests/unit/errors.test.mjs` — 6-8 assertions: each known error class maps to the right code; zod error → -32602; `MCPError` extends Error; `renderError` produces the MCP `{isError: true, content: [...], error: {...}}` shape; `retryable` flag round-trips.
- `tests/unit/render.test.mjs` (extend) — 3 new cases: 10s timeout throws -32001; jsdom init throws on first try, succeeds on retry, returns valid mermaid; jsdom init throws on both tries, throws -32003; ascii-failure increments counter and surfaces in `warnings` (when S02 wires warnings to the response; for S03, the counter is enough).
- `tests/unit/storage.test.mjs` (extend) — 3 new cases: writeFile retry on EAGAIN; writeFile no-retry on ENOSPC; readFile timeout (5s).

**Integration (extend S01's two files):**
- `tests/integration/http.test.mjs` (extend) — new case: after a `tools/call render_mermaid` + a malformed `tools/call`, GET `/health` returns `counters.render_total === 1` AND `counters.render_errors === 1` AND `last_errors.length === 1` AND `last_errors[0].code === -32002`.
- `tests/integration/stdio-mcp.test.mjs` (extend) — new case: `tools/call` with `{code: "x" > 200_000}` returns `{isError: true, error: {code: -32602, ...}}`; existing 3 tests must still pass unchanged.
- **Port-fallback test** — small wrapper that calls `tryListen(server, port)` 3 times with a real net.Server; assert EADDRINUSE → retry → eventual success. Not a server.mjs import; test the helper directly.

**No new eval files needed.** S03 is infrastructure; it strengthens the existing 9 evals' stability (more logging, more error surface) but adds no new end-user behavior to eval. Note in S03-SUMMARY: "R008/R009/R010/R015-R018/R020 advanced by infrastructure; no new evals".

### Files to create / modify

**Create:**
- `src/logger.mjs` (~30 LOC)
- `src/counters.mjs` (~80 LOC)
- `src/errors.mjs` (~120 LOC)
- `tests/unit/logger.test.mjs`
- `tests/unit/counters.test.mjs`
- `tests/unit/errors.test.mjs`
- `tests/integration/helpers/port-fallback.mjs` (if extracted for testability; otherwise inline in server.mjs and test via integration)

**Modify:**
- `src/server.mjs` — import new modules; wire into CallTool handler; extend /health; wrap HTTP listen with retry; pass counters+logger to storage + render
- `src/render.mjs` — add timeout wrapper; add 1× jsdom retry; expose `__reset*` seams; add ascii-failure counter increment
- `src/storage.mjs` — wrap writes in retry; wrap reads in timeout; sweep increments counters; save() uses tmp+rename
- `src/helpers.mjs` — replace `log()` body (keep export name) OR re-export `log` from `src/logger.mjs` (cleaner)
- `package.json` — add `zod` to `dependencies` (currently only transitive)
- `docs/api.md` — document new /health fields and error code table
- `docs/mcp-protocol.md` — document the error contract (`{isError, content, error: {code, message, retryable}}`); add a note that error.code is the inner code, not the JSON-RPC envelope
- `README.md` — brief note that observability surface is in place (R008/R009/R010); point to /health for ops

### Verification

End-to-end verification, ordered by blast radius (cheapest first):

1. `node --check src/{server,render,storage,logger,counters,errors}.mjs` — parse sanity for the 3 new modules.
2. `npm test` — must pass all 47+ existing tests (1 todo unchanged) PLUS new unit tests. Total target: ~75-80 tests passing, 1 todo. Watch the existing 9 eval tests; they must not regress.
3. `npm run test:coverage` — `lines: 80` threshold must hold on included files (helpers.mjs / render.mjs / storage.mjs / logger.mjs / counters.mjs / errors.mjs). src/server.mjs stays excluded per S01.
4. **Manual smoke (mandatory before marking S03 done):** spawn the server, render a valid diagram, render a malformed one, then `curl http://127.0.0.1:<port>/health` and verify:
   - stderr shows 3+ JSON log lines (one for boot, one for each render)
   - `counters.render_total === 1`, `counters.render_errors === 1`
   - `last_render_ms > 0`
   - `last_errors.length === 1`, `last_errors[0].code === -32002`
5. **Manual retry smoke:** `MERMAID_RENDER_TIMEOUT_MS=1 node src/server.mjs` + render a complex gantt — verify stderr shows `render_timeout` and counters increment.
6. **Manual persistence smoke:** render → kill server → restart → `/health` shows the previous render_total (proves load+save works).

## Risks & Open Questions

### Risks (ordered by severity)

- **R-A (high): JSON-RPC code namespace ambiguity.** S03's "错误码 -32001 到 -32009" wording in the slice plan collides with the SDK's transport-level -32000/-32001. Mitigation: explicit `errors.mjs` header comment + the table above + a sentence in the slice's verification checklist. No code change needed — R020 already constrains the shape correctly — but planner must surface this in the task description.
- **R-B (high): S03 ↔ S02 ordering.** S03 depends on S01 only (per `depends:[S01]`), but S02 depends on S01 and conceptually on S03's error contract. Per the dep graph, S02 lands AFTER S03. Mitigation: S03 ships the error framework + applies it to render_mermaid only; S02's tasks say "adopt the framework for the 6 new tools" — no rewiring. The 7-tool eval contract is S04's concern, not S02/S03.
- **R-C (medium): Counter write contention.** Concurrent renders increment counters; if two `increment()` calls run in parallel, the tmp+rename can race and the loser's tmp can clobber the winner. Mitigation: serialize via an internal mutex (single-flight promise chain) OR use a per-key tmp file. Recommend single-flight — adds ~10 LOC, no new dep.
- **R-D (medium): fs.rename on Windows.** `fs.rename` is documented to be atomic on POSIX; on Windows, behavior depends on the target filesystem and whether the destination is open. For a 200-byte counters.json, the practical risk is near-zero, but planner should add a unit test that explicitly verifies the tmp file is unlinked after rename on Windows (S01 pattern: use `os.platform()` in the assertion or skip with a TODO).
- **R-E (medium): Render timeout reliability in CI.** mermaid 11 is fast (< 2s typically). To reliably hit a 10s timeout in a unit test, the test must inject a slow mermaid via the test seam. If the test seam is not added, the timeout code path is un-exercised in CI. Mitigation: ship `__setMermaidRenderForTesting(fn)` AND write a test that uses it.
- **R-F (medium): existing render.mjs error messages.** The current code throws `new Error("mermaid parse error: ...")` (line 75), `new Error("empty mermaid source")` (line 49), `new Error("mermaid source too long (X chars, max 200000)")` (line 53). S03's error contract must map these to {code, message, retryable} without breaking the message string (the 9 existing eval tests assert on the message text — e.g., `eval-04` checks `/^mermaid parse error:/`, `eval-07` checks `mermaid source too long` + `200001`). Mitigation: domain-error classification preserves the original message verbatim; only the wrapping `MCPError.code` is new.
- **R-G (low): Port-fallback test flakiness on CI.** A test that actually tries to bind 5300/5301/5302 can collide with the user's other processes on the same runner. Mitigation: the helper function takes the port list as a parameter; tests use a free-port discovery pattern (S01's `netCreateServer().listen(0)` from `tests/integration/http.test.mjs:22-33`) and pass the 3 free ports.
- **R-H (low): zod 4.x API churn.** zod 4 changed some APIs from v3 (`z.string().email()` → `z.email()`, error format is different). The plan says "zod 4.x" but doesn't pin a specific sub-API. Mitigation: use only stable surface (`z.object({...}).safeParse(input)`, `error.issues[].message`). Avoid `z.string().email()`-style chains.

### Open questions for the planner

1. **`last_render_ms` semantics** — update on every render attempt (success or fail), or only on success? Recommend: on every completed attempt (so the field reflects "how long the last attempt took", useful for diagnosing slow-fail cases). The counter tracks success vs error separately.
2. **Counter increment frequency** — write to disk on every `increment()`, or batched? The plan's CONTEXT says "每次 increment 时 save(用 tmp+rename 原子写)" — every increment. Stick with that. ~5-10 FS writes per render is negligible.
3. **Empty 5-error ring at boot** — should `last_errors` default to `[]` or be omitted? Recommend: always present (empty array), so consumers don't have to check `undefined`. JSON shape is then stable.
4. **`httpLink: null` vs absent** — the existing render_mermaid response has `httpLink: null` when HTTP is off. S03 must preserve this. Mentioned for awareness; not a new decision.
5. **Should the 5-error ring be exposed in tests?** Yes — a `tests/integration/http.test.mjs` test injects 2 errors via `tools/call` with bad input, then asserts `last_errors.length === 2` and the codes are correct. S01 already covers `/health` shape; S03 just extends it.
6. **zod as a direct dep vs relying on transitive.** Recommend: add to `dependencies` in package.json. The SDK is the only thing that uses it transitively today; the moment the SDK upgrades zod, we get a surprise. Direct dep pins the version.
7. **What goes in `warnings` for the existing render_mermaid?** Currently nothing. S03 should add: `["ascii_failed: <reason>"]` when mermaid-ascii throws. R025 already calls for this. The `warnings` field is added to the render_mermaid response shape (additive, non-breaking per R020).

### S03 ↔ S02 ordering decision (the planner's call)

The roadmap says S02 depends on S01, S03 depends on S01. They could in principle land in either order. S03 first is the safe pick because:

- S03 is infrastructure (logger, counters, errors, retry). S02 is feature (6 new tools).
- S02's tasks naturally include "wrap each tool in the error contract" — easier if the contract is already shipped.
- The 7-tool S04 acceptance criteria (MCP Inspector all 7 tools) doesn't differentiate order.
- The risk of "S02 lands without an error contract" is higher than "S03 lands before its consumers" because the latter is purely internal; the former leaks bad error shapes into 6 tools.

If the planner chooses S02-first, S03's "apply to render_mermaid" task shrinks to "apply to all 7 tools" (no behavior change), but S02's tasks grow to "wrap each tool in `{... payload, elapsed_ms, warnings?}`" without the framework. Recommend S03 first.

## Implementation Landscape

### Pattern: structured stderr JSON (matches existing `console.error` text)

The current `log()` (`src/helpers.mjs:78-82`):

```js
export function log(...args) {
	const ts = new Date().toISOString().slice(11, 19);
	console.error(`[${ts}][mermaid-renderer]`, ...args);
}
```

S03's replacement (~30 LOC, drop-in):

```js
// src/logger.mjs
import { EOL } from "node:os";
const REQUIRED = ["ts", "level", "event"];

export function log({ level = "info", event, code, id, ...rest }) {
	const ts = new Date().toISOString();
	const record = { ts, level, event, ...(code != null ? { code } : {}), ...(id != null ? { id } : {}), ...rest };
	process.stderr.write(JSON.stringify(record) + EOL);
}
```

Keep the same export name `log` so `src/server.mjs:5` and the 5 other call sites need no change. Update `src/helpers.mjs:78-82` to re-export from `src/logger.mjs` (preserves MEM015's `grep -c "^export" === 6` audit count from S01).

### Pattern: atomic counter write

```js
// src/counters.mjs (skeleton)
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const COUNTER_KEYS = ["render_total", "render_errors", "ascii_failures",
                      "storage_write_retries", "sweep_runs", "sweep_removed"];

export class Counters {
	constructor(root) {
		this.path = join(root, "counters.json");
		this.tmpPath = join(root, "counters.json.tmp");
		this.values = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
		this._writeChain = Promise.resolve();
	}

	async load() {
		try {
			const raw = await readFile(this.path, "utf-8");
			const obj = JSON.parse(raw);
			for (const k of COUNTER_KEYS) if (typeof obj[k] === "number") this.values[k] = obj[k];
		} catch {
			// corrupted; start fresh
			this.values = Object.fromEntries(COUNTER_KEYS.map((k) => [k, 0]));
		}
	}

	increment(key) {
		this._writeChain = this._writeChain.then(async () => {
			this.values[key] = (this.values[key] ?? 0) + 1;
			const payload = JSON.stringify(this.values, null, 2);
			await writeFile(this.tmpPath, payload, "utf-8");
			await rename(this.tmpPath, this.path);
		});
		return this._writeChain;
	}

	snapshot() {
		return { ...this.values };
	}
}
```

The `_writeChain` mutex serializes increments within one process. Multi-process safety is out of scope (R037).

### Pattern: error classification via zod

```js
// src/errors.mjs (skeleton)
import { z } from "zod";

export const ErrorCode = Object.freeze({
	InvalidParams: -32602,
	RenderTimeout: -32001,
	RenderFailed: -32002,
	JsdomInitFailed: -32003,
	StorageWriteFailed: -32004,
	StorageReadFailed: -32005,
	PortInUse: -32008,
	McpProtocolViolation: -32009,
});

const TRANSIENT = new Set([ErrorCode.StorageWriteFailed, ErrorCode.StorageReadFailed, ErrorCode.PortInUse]);
const RETRYABLE = (code) => TRANSIENT.has(code);

export function classifyZodError(zodErr) {
	const msg = zodErr.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
	return { code: ErrorCode.InvalidParams, message: msg, retryable: false };
}

export function classifyDomainError(err) {
	if (err?.code != null && typeof err.code === "number") {
		return { code: err.code, message: err.message ?? String(err), retryable: RETRYABLE(err.code) };
	}
	// fallback for legacy Error throws (e.g., from render.mjs)
	const msg = err?.message ?? String(err);
	if (msg.startsWith("mermaid parse error:")) {
		return { code: ErrorCode.RenderFailed, message: msg, retryable: false };
	}
	if (msg.startsWith("mermaid source too long") || msg.startsWith("empty mermaid source")) {
		return { code: ErrorCode.InvalidParams, message: msg, retryable: false };
	}
	return { code: ErrorCode.InternalError ?? -32603, message: msg, retryable: false };
}

export function renderError({ code, message, retryable, ...rest }) {
	return {
		isError: true,
		content: [{ type: "text", text: JSON.stringify({ error: { code, message, retryable, ...rest } }) }],
		error: { code, message, retryable, ...rest },
	};
}
```

### Pattern: HTTP port fallback (the only place that needs unref'd retry)

```js
// inside src/server.mjs (sketch)
import { setTimeout as sleep } from "node:timers/promises";

async function tryListen(server, host, ports) {
	for (const port of ports) {
		try {
			await new Promise((resolve, reject) => {
				const onError = (e) => { server.off("listening", onOk); reject(e); };
				const onOk = () => { server.off("error", onError); resolve(); };
				server.once("error", onError);
				server.once("listening", onOk);
				server.listen(port, host);
			});
			return port;
		} catch (e) {
			if (e?.code !== "EADDRINUSE" || port === ports[ports.length - 1]) throw e;
			log({ level: "warn", event: "port_in_use", port, next: port + 1 });
			await sleep(50);
		}
	}
}
```

In HTTP-enabled mode, replace `httpServer.listen(HTTP_PORT, HTTP_HOST, ...)` with `await tryListen(httpServer, HTTP_HOST, [5300, 5301, 5302])`. The `sleep(50)` is unref'd by virtue of `node:timers/promises` returning a promise that doesn't hold the loop.

## Architecture

The piece-by-piece flow for a single `tools/call render_mermaid`:

```
client request
    ↓
server.mjs CallToolRequestSchema handler
    ↓
try {
  const t0 = Date.now();
  const { id, svg, ascii, sourceLength } = await render(code, title);  // timeout, jsdom retry inside
  await storage.put(id, code, svg, sourceLength, title);              // write retry inside
  const html = await renderView(...);
  await writeFile(`blobs/${id}.html`, html);                           // write retry inside
  counters.increment("render_total");
  if (asciiFailed) counters.increment("ascii_failures");
  last_render_ms = Date.now() - t0;
  return { content: [...], elapsed_ms, warnings? };
} catch (e) {
  counters.increment("render_errors");
  recordError(e);                            // pushes to 5-ring buffer
  const classified = classifyDomainError(e);
  return renderError(classified);
}
```

The MCP `CallToolResult` shape for both success and failure stays additive — existing fields (id, ascii, fileLink, httpLink) untouched; new fields (elapsed_ms, warnings) appended; failure branch uses `isError: true` + a separate `error: {code, message, retryable}` object inside the content.

## Key Code

The single function that everything hinges on is `classifyDomainError` in `src/errors.mjs`. It is the chokepoint that converts the existing `throw new Error("mermaid parse error: ...")` (and friends) from `src/render.mjs:75,49,53` into the structured `{code, message, retryable}` shape. If this function is wrong, the error contract is wrong, and 9 existing eval tests start failing on substring assertions.

The second-most-important function is `Counters.increment()` in `src/counters.mjs`. The single-flight mutex (`_writeChain`) is the only thing standing between "counters work" and "counters lose writes under load". Unit test: fire 100 increments in `Promise.all`, assert `snapshot().render_total === 100`.

The third is `tryListen` in `src/server.mjs`. The EADDRINUSE classification (`e?.code !== "EADDRINUSE"`) is the single line that distinguishes "retry the next port" from "give up and throw -32008".

## Start Here

1. **Read `src/server.mjs`** end-to-end (already done in this scout) to understand the bootstrap sequence and where the 3 retry points hook in.
2. **Read `src/render.mjs`** (already done) to find the 3 throw sites and the `getMermaid` cache.
3. **Read `src/storage.mjs`** (already done) to find the 3 writeFile sites and 1 readFile site.
4. **Read `src/helpers.mjs` lines 78-82** to see the current `log()` shape that S03 must replace.
5. **Read the 9 existing eval tests** under `tests/evals/` to lock the current contract (S01 already did; S03 must not regress).
6. **Then start with the S03 planner; the natural task order is:**
   - T1: `src/logger.mjs` + `tests/unit/logger.test.mjs` (smallest, no deps)
   - T2: `src/counters.mjs` + `tests/unit/counters.test.mjs` (no deps, slightly larger)
   - T3: `src/errors.mjs` + `tests/unit/errors.test.mjs` (depends on nothing in S03)
   - T4: modify `src/render.mjs` for timeout + jsdom retry; extend `tests/unit/render.test.mjs`
   - T5: modify `src/storage.mjs` for write retry + read timeout + atomic save; extend `tests/unit/storage.test.mjs`
   - T6: modify `src/server.mjs` to wire T1-T5 into the call path; extend `tests/integration/stdio-mcp.test.mjs` and `tests/integration/http.test.mjs`
   - T7: add `zod` to package.json; update `docs/api.md` and `docs/mcp-protocol.md`
   - T8: manual smoke (render valid + malformed, check /health, restart, check persistence)

T1, T2, T3 are independent and can be done in any order. T4-T5 depend on T1 (use the logger). T6 depends on T1-T5. T7 is documentation. T8 is the integration check that no unit test can replace.

## Files Retrieved

1. `src/server.mjs` (lines 1-218) — dual-protocol bootstrap, CallToolRequestSchema handler, /health route, SIGTERM/SIGINT handlers, unref'd sweep setInterval at line 59.
2. `src/helpers.mjs` (lines 1-83) — six pure helpers; `log()` at lines 78-82 is the function S03 must replace.
3. `src/render.mjs` (lines 1-107) — jsdom init in `getMermaid()` cached in `mermaidPromise`; 3 throw sites (49, 53, 75); ascii failure swallowed at 101-104.
4. `src/storage.mjs` (lines 1-150) — 3 `writeFile` sites (save, sweep, put), 1 `readFile` site (readSvg); `pruneIfExpired` does sync unlink.
5. `package.json` (full) — zod 4.4.3 is on disk transitively; must be added as direct dep. Engines node >= 22.0.0; scripts: test, test:watch, test:coverage. No logger/counter/error deps.
6. `tests/helpers/server.mjs` (lines 1-100) — JSON-RPC driver; sends `initialize` + `tools/list` + `tools/call`. S03 will reuse for the new isError assertions.
7. `tests/helpers/storage-fixture.mjs` (lines 1-30) — `makeTempStorage()` pattern: `mkdtemp` + `Storage.load()`. S03 mirrors with `makeTempCounters()`.
8. `tests/integration/http.test.mjs` (lines 1-130) — free-port discovery at 22-33; `waitForHealth` at 35-55; per-test temp data dir. S03's /health extension test follows the same shape.
9. `tests/integration/stdio-mcp.test.mjs` (lines 1-100) — 3 stdio tests; S03 adds a 4th asserting `isError: true` shape.
10. `tests/unit/{render,server-helpers,storage,sanity}.test.mjs` (full) — S01 locked the v0.1.0 surface; S03 extends render + storage.
11. `tests/evals/eval-01..10.test.mjs` (full) — 9 real assertions + 1 it.todo; S03 must not regress any.
12. `vitest.config.mjs` (full) — server.mjs excluded from coverage; S03's new modules are included by default.
13. `docs/api.md` and `docs/mcp-protocol.md` (full) — current API + protocol docs; S03 extends the /health section and adds the error contract block.
14. `docs/integration/gsd-pi.md` (full) — gsd-pi mcp.json config; not directly affected by S03, but S03's stderr JSON logs will be visible in gsd-pi's MCP child output.
15. `.gsd/milestones/M001/M001-CONTEXT.md` (full) — architectural decisions + error handling strategy (D004 zod, R008-R020 list).
16. `.gsd/milestones/M001/slices/S01/S01-SUMMARY.md` (full) — S01 follow-up: "S03 must add a stderr JSON log fixture test that does not interfere with the unit-test silence." (the logger test should not pollute stderr during the other unit tests — use `vi.spyOn(process.stderr, 'write')` and restore in afterEach).
17. `node_modules/@modelcontextprotocol/sdk/dist/cjs/types.d.ts` (line 2128-2137) — ErrorCode enum: -32000 ConnectionClosed, -32001 RequestTimeout. This is the namespace-collision surface S03 must avoid at the JSON-RPC envelope level.
18. `node_modules/zod/package.json` (full) — zod 4.4.3; main `./index.cjs`, module `./index.js` (v4 classic external).

## Memory Hooks (for `capture_thought` after planning)

These are durable, cross-slice insights worth saving into the GSD memory store once S03 lands:

- (architecture) **Error code namespace** — R020's `error.code` is the inner payload code, not the JSON-RPC envelope code. S03 docs this explicitly to prevent future -32001 collisions with the SDK's transport-level codes.
- (gotcha) **fs.rename on Windows** — atomicity is near-atomic; for tiny JSON files (< 1KB) the practical risk is zero. For larger files, document the tradeoff.
- (pattern) **Test seam for render timeout** — `__setMermaidRenderForTesting(fn)` lets a unit test inject a never-resolving promise to deterministically hit the 10s timeout. Without this, the timeout code path is un-exercised in CI.
- (convention) **Counter file mutex** — single-flight promise chain serializes `increment()` calls within one process; multi-process is out of scope (R037) and the slice plan acknowledges this.
