# Project Knowledge

Append-only register of project-specific rules, patterns, and lessons learned.
Agents read this before every unit. Add entries when you discover something worth remembering.
## Rules

| # | Scope | Rule | Why | Added |
|---|-------|------|-----|-------|

## Patterns

| # | Pattern | Where | Notes |
|---|---------|-------|-------|
| P001 | Structured stderr JSON logger: `log({level="info", event, code?, id?, ...rest})` writes one line per call to `process.stderr` with stable field order `{ts, level, event, code, id, ...rest}`. `code` and `id` are OMITTED (not null) when null/undefined. | `src/logger.mjs` | Re-exported by `src/helpers.mjs` to keep server.mjs's 6 single-name `^export` invariant. Test with `vi.spyOn(process.stderr, "write")` + afterEach restore. |
| P002 | Persistent counters via tmp+rename atomic write: write to `<root>/counters.json.tmp` then `rename()` to the real path. Best-effort unlink of a stale `.tmp` on `load()` recovers from mid-rename crashes. | `src/counters.mjs` | Single-flight mutex via `this._writeChain = this._writeChain.then(...)`. 100 concurrent increments converge to 100. |
| P003 | Forward-compat counter keys: `increment(unknownKey)` creates the key with default 0 and persists it. The 6 documented `COUNTER_KEYS` are seeded on `load()`; extras are preserved across a new `Counters` instance. | `src/counters.mjs` | Lets future tasks (T03/T04/T05) add ad-hoc metrics without a code change here. |

## Lessons Learned

| # | What Happened | Root Cause | Fix | Scope |
|---|--------------|------------|-----|-------|
