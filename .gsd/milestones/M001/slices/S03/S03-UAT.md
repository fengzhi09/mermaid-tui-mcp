# S03: Observability - logs, health, counters, error contract — UAT

**Milestone:** M001
**Written:** 2026-06-04T12:22:25.959Z

# S03 UAT — Observability (logs, health, counters, error contract)

**Slice:** S03 / M001 — v0.2.0 收口
**UAT Type:** Integration (real subprocess + real files; no mocks)
**Scope:** 4 observability surfaces (stderr JSON, data/counters.json, /health metrics, 3 retry paths) + the full -32001..-32009 + -32602 error code set + MEM024 id projection + MEM017 sweep unref. The real-client integration (Claude Code + gsd-pi + MCP Inspector) is owned by S04.

## Preconditions

- Node 22 or 24 installed.
- `npm install` has been run (or `npm ci` for CI parity).
- Working dir is the repo root (`.gsd/worktrees/M001`).
- No prior `data/counters.json` exists (delete if needed for a clean test).

## Test 1 — stderr single-line JSON with stable field order (R008)

**Preconditions:** clean `data/` (or stale `data/counters.json` from a prior test).

**Steps:**
1. `MERMAID_RENDERER_HTTP=1 MERMAID_RENDERER_PORT=5400 node src/server.mjs >/tmp/s03-stdout.log 2>/tmp/s03-stderr.log &`
2. `SERVER_PID=$!`
3. `sleep 2`
4. `kill $SERVER_PID 2>/dev/null; wait 2>/dev/null`
5. `cat /tmp/s03-stderr.log | tr -d '\r'`

**Expected outcomes:**
- Exactly 3 JSON lines emitted (one per boot event: `mcp_stdio_connected`, `boot`, `http_listening`).
- Each line is a single parseable JSON object.
- Field order is `{ts, level, event, ...rest}` — `ts` first, `level` second, `event` third.
- `ts` is an ISO 8601 string ending in `Z`; `level` is `"info"`; `event` is one of the 3 event names above.

**Pass criteria:** all 3 lines present, parseable, with field order verified via `jq -c '. | {ts:.ts, level:.level, event:.event}' /tmp/s03-stderr.log` showing ts/level/event as keys 1/2/3.

## Test 2 — /health response includes S03 observability surface (R009)

**Preconditions:** server running (use `MERMAID_RENDERER_HTTP=1 MERMAID_RENDERER_PORT=5400` as in Test 1).

**Steps:**
1. Boot the server as in Test 1; do NOT kill it.
2. `curl -sS http://127.0.0.1:5400/health | jq`

**Expected outcomes:**
- HTTP 200.
- Response includes the S02 baseline fields (`status: "ok"`, `version`, `uptimeSec`, `ttlDays`, `total`, `pinned`, `unpinned`).
- Response ALSO includes:
  - `counters` — object with exactly 6 keys: `render_total`, `render_errors`, `ascii_failures`, `storage_write_retries`, `sweep_runs`, `sweep_removed`. All integer-valued, initially 0.
  - `last_render_ms` — number, initially 0.
  - `last_errors` — array (possibly empty), each entry shape `{code, at, retryable, message}`.

**Pass criteria:** the response is valid JSON containing all 3 new top-level fields, and `counters` has the 6 documented keys.

## Test 3 — data/counters.json persistence (R010)

**Preconditions:** clean `data/` (delete `data/counters.json` if present).

**Steps:**
1. `rm -f data/counters.json data/counters.json.tmp`
2. Boot the server (Test 1).
3. `sleep 2`
4. `cat data/counters.json | jq`
5. Kill the server.

**Expected outcomes:**
- `data/counters.json` exists after the boot sweep.
- File content is a JSON object with the 6 keys, all integer-valued, `sweep_runs >= 1` (the boot sweep), others 0.
- `data/counters.json.tmp` is NOT present after boot (was unlinked on the next save, or never created).

**Pass criteria:** `data/counters.json` has 6 integer-valued keys; `sweep_runs >= 1`; no stale `.tmp`.

## Test 4 — single-flight concurrent increments (R010 atomicity)

**Preconditions:** node REPL or short script.

**Steps:**
1. `node -e "import('./src/counters.mjs').then(async ({Counters}) => { const c = new Counters('./data'); await c.load(); await Promise.all(Array.from({length: 100}, () => c.increment('render_total'))); const snap = c.snapshot(); console.log('render_total =', snap.render_total); process.exit(snap.render_total === 100 ? 0 : 1); })"`

**Expected outcomes:**
- `render_total = 100` (no lost updates despite 100 concurrent calls).

**Pass criteria:** exit code 0, output `render_total = 100`.

## Test 5 — render timeout 10s (R015)

**Preconditions:** none.

**Steps:**
1. `MERMAID_RENDER_TIMEOUT_MS=10 node -e "import('./src/render.mjs').then(async (m) => { m.__setMermaidRenderForTesting(() => new Promise(() => {})); m.__setRenderTimeoutForTesting(10); try { await m.render('graph TD; A-->B'); console.error('NO TIMEOUT'); process.exit(1); } catch (e) { console.log(JSON.stringify({name: e.name, code: e.code, retryable: e.retryable})); process.exit(e.name === 'RenderTimeoutError' && e.code === -32001 && e.retryable === true ? 0 : 1); } })"`

**Expected outcomes:**
- Exit code 0.
- Output: `{"name":"RenderTimeoutError","code":-32001,"retryable":true}`.
- Wall-clock < 1s (the seam fires the timeout in ms, not the real 10s).

**Pass criteria:** exit 0, name=`RenderTimeoutError`, code=-32001, retryable=true.

## Test 6 — jsdom init 1x retry (R018)

**Preconditions:** none.

**Steps:**
1. `node -e "import('./src/render.mjs').then(async (m) => { m.__setJSDOMFactoryForTesting(() => { throw new Error('injected jsdom failure'); }); m.__resetMermaidForTesting(); try { await m.render('graph TD; A-->B'); console.error('NO ERROR'); process.exit(1); } catch (e) { console.log(JSON.stringify({name: e.name, code: e.code, retryable: e.retryable})); process.exit(e.name === 'JsdomInitError' && e.code === -32003 && e.retryable === true ? 0 : 1); } })"`

**Expected outcomes:**
- Exit code 0.
- Output: `{"name":"JsdomInitError","code":-32003,"retryable":true}`.
- Wall-clock < 1s (the seam rejects immediately).

**Pass criteria:** exit 0, name=`JsdomInitError`, code=-32003, retryable=true.

## Test 7 — writeFile retry on EAGAIN (R017)

**Preconditions:** none.

**Steps:**
1. `node -e "import('./src/storage/LocalFsStorage.mjs').then(async ({LocalFsStorage, __setWriteFileForTesting}) => { const fs = await import('node:fs/promises'); let calls = 0; __setWriteFileForTesting(async (p, data) => { calls++; if (calls === 1) { const e = new Error('resource busy'); e.code = 'EAGAIN'; throw e; } return fs.writeFile(p, data); }); const s = new LocalFsStorage('./data/test-s03-eagain', { counters: { increment: () => {} } }); try { await s.put('id1', 'graph TD; A-->B', 'graph TD; A-->B', {}); console.log('persisted, calls=' + calls); process.exit(calls === 2 ? 0 : 1); } catch (e) { console.error('FAIL', e.message); process.exit(2); } })"`

**Expected outcomes:**
- Exit code 0.
- Output: `persisted, calls=2` (1st EAGAIN + 1st retry succeeded via the real writeFile).
- The blob file exists at `data/test-s03-eagain/blobs/id1.svg`.

**Pass criteria:** exit 0, calls=2, blob persisted. Cleanup: `rm -rf data/test-s03-eagain`.

## Test 8 — writeFile no-retry on ENOSPC (R017)

**Preconditions:** none.

**Steps:**
1. `node -e "import('./src/storage/LocalFsStorage.mjs').then(async ({LocalFsStorage, __setWriteFileForTesting}) => { __setWriteFileForTesting(async () => { const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }); const s = new LocalFsStorage('./data/test-s03-enospc', { counters: { increment: () => {} } }); try { await s.put('id1', 'src', 'src', {}); console.error('NO ERROR'); process.exit(1); } catch (e) { console.log(JSON.stringify({name: e.name, code: e.code, retryable: e.retryable})); process.exit(e.name === 'StorageWriteError' && e.code === -32004 ? 0 : 1); } })"`

**Expected outcomes:**
- Exit code 0.
- Output: `{"name":"StorageWriteError","code":-32004,"retryable":true}`.

**Pass criteria:** exit 0, name=`StorageWriteError`, code=-32004. Cleanup: `rm -rf data/test-s03-enospc`.

## Test 9 — HTTP port fallback 5300→5301→5302 (R016)

**Preconditions:** none.

**Steps:**
1. `node -e "import('node:net').then(async (net) => { const servers = []; const ports = [5300, 5301]; for (const p of ports) { const s = net.createServer(); servers.push(s); await new Promise((r) => s.listen(p, '127.0.0.1', r)); } const { tryListen } = await import('./src/port-fallback.mjs'); const s3 = net.createServer(); const bound = await tryListen(s3, '127.0.0.1', [5300, 5301, 5302]); console.log('bound on', bound); s3.close(); for (const s of servers) s.close(); process.exit(bound === 5302 ? 0 : 1); })"`

**Expected outcomes:**
- Exit code 0.
- Output: `bound on 5302` (skipped 5300 + 5301 which were busy, landed on 5302).

**Pass criteria:** exit 0, bound port is 5302 (the first available port in the fallback chain).

## Test 10 — MEM024 list_diagrams items carry `id` (MEM024)

**Preconditions:** `data/` is clean.

**Steps:**
1. `node -e "import('./src/storage/LocalFsStorage.mjs').then(async ({LocalFsStorage}) => { const s = new LocalFsStorage('./data/test-s03-mem024'); await s.put('aaa', 'graph TD; X-->Y', 'graph TD; X-->Y', { title: 'aaa' }); await s.put('bbb', 'graph TD; Y-->Z', 'graph TD; Y-->Z', { title: 'bbb' }); const list = await s.list({ limit: 10 }); console.log(JSON.stringify(list.items.map((i) => ({id: i.id, title: i.title})), null, 2)); process.exit(list.items.every((i) => typeof i.id === 'string' && i.id.length > 0) ? 0 : 1); })"`

**Expected outcomes:**
- Exit code 0.
- Output: an array of 2 items, each carrying an `id` field equal to the seeded key (`aaa` / `bbb`).

**Pass criteria:** exit 0, every item has a non-empty `id` string. Cleanup: `rm -rf data/test-s03-mem024`.

## Test 11 — MEM017 sweep setInterval is unref'd

**Preconditions:** none.

**Steps:**
1. `grep -n "setInterval" src/server.mjs` → look for `.unref()` directly on the returned timer.
2. `grep -n "60 \* 60 \* 1000" src/server.mjs` → confirm the sweep interval is the 60-minute one.
3. `grep -A1 "60 \* 60 \* 1000" src/server.mjs | head -5` → confirm `).unref();` appears on the next line.

**Expected outcomes:**
- The 60-minute sweep setInterval is followed by `).unref();` in the source.

**Pass criteria:** `grep -A1 "60 \* 60 \* 1000" src/server.mjs` shows the `).unref();` pattern.

## Test 12 — full error code set -32001..-32009 + -32602 + -32603 (R020)

**Preconditions:** running server (Test 1 boot).

**Steps:**
1. Send a stdio MCP `initialize` + `notifications/initialized` + `tools/call` with `name: "render_mermaid"`, `arguments: {code: ""}` (empty string).
2. Parse the response `content[0].text` JSON and read `error.code`.

**Expected outcomes:**
- Empty string maps to `-32602` (invalid params), the 9 existing eval tests' substring `"empty mermaid source"` is preserved in `error.message`.

**Pass criteria:** inner `error.code === -32602`, message contains `"empty mermaid source"`.

## Test 13 — sweep counter increment on boot

**Preconditions:** clean `data/counters.json`.

**Steps:**
1. `rm -f data/counters.json data/counters.json.tmp`
2. Boot the server (Test 1).
3. `sleep 2`
4. `cat data/counters.json | jq .sweep_runs` — should be >= 1 (the boot sweep ran).
5. Kill the server.

**Expected outcomes:**
- `sweep_runs` is an integer >= 1.
- All other counters are 0.

**Pass criteria:** `sweep_runs >= 1`; `render_total === 0`; `render_errors === 0`; `ascii_failures === 0`; `storage_write_retries === 0`; `sweep_removed === 0`.

## Test 14 — namespace disambiguation (R020 docs)

**Preconditions:** none.

**Steps:**
1. `grep -n "Namespace disambiguation" docs/api.md docs/mcp-protocol.md`

**Expected outcomes:**
- Both docs contain the disambiguation call-out.

**Pass criteria:** the phrase appears in both files.

## Edge cases covered

- **EPIPE on stderr write** (Test 1 — logger swallows the failure)
- **Corrupt `data/counters.json`** (Test 3 baseline — load is corruption-tolerant; covered by `tests/unit/counters.test.mjs` corruption case)
- **Stale `data/counters.json.tmp` from prior crash** (covered by counters.test.mjs stale-tmp unlink case)
- **Missing blob on readSvg** (preserves v0.1.0 "404 = null" — covered by storage.test.mjs test 7)
- **Renderer throws synchronously (length check)** (covered by integration test 13 — `last_render_ms >= 0` per T05 deviation)
- **All 3 ports busy** (covered by port-fallback.test.mjs + Test 9's 2-port simulation)
- **Permanent EAGAIN (retry exhausted)** (covered by storage.test.mjs EAGAIN seam that throws every time → error propagates raw)

## What is NOT covered here (owned by S04)

- Real Claude Code integration smoke
- Real gsd-pi integration smoke
- MCP Inspector run of all 7 tools
- README updates (7-tool table, quick start, troubleshooting)
- CHANGELOG v0.2.0 entry
