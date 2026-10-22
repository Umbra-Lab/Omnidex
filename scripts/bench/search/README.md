# FTS5 search-latency benchmark

Measures the real per-keystroke search latency of OmniDex's SQLite FTS5 index —
the **exact** query `searchAssets()` runs in
[`electron/main/db/repos/assets.ts`](../../../electron/main/db/repos/assets.ts).
Results land in [`RESULTS.md`](RESULTS.md).

## Why it runs through Electron

`better-sqlite3` is a native module compiled against **Electron's** ABI
(`NODE_MODULE_VERSION 145`), not your system Node. Running these scripts under
plain `node` fails with `ERR_DLOPEN_FAILED`. Run them as **Electron-as-node**,
which reuses the already-built binary without a rebuild:

```bash
# from the repo root
pnpm bench:search        # snapshot live DB + generate 10k/50k + bench all + write RESULTS.md

# or invoke a piece directly:
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/bench/search/run-all.mjs
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/bench/search/gen-synthetic.mjs out.db 10000
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/bench/search/bench-fts.mjs out.db --iters=1000 --label=10k
```

## Files

| File | Role |
|---|---|
| `lib/query.mjs` | The search SQL, `buildFtsQuery` sanitizer, `CARD_COLUMNS`, BM25 weights, and the query suite — **mirrored 1:1 from `assets.ts`**. Single source of truth. |
| `lib/generate.mjs` | Deterministic synthetic-DB generator (faithful `assets` + `assets_fts` schema, live-like null distribution). |
| `lib/bench.mjs` | The measurement core: warmup + timed iterations, p50/p95/p99 via `process.hrtime.bigint()`. |
| `run-all.mjs` | Orchestrator: snapshot live DB (online backup), gen 10k/50k, bench all, write `RESULTS.md`. |
| `gen-synthetic.mjs` / `bench-fts.mjs` | Thin CLI wrappers over the libs. |
| `RESULTS.md` | Committed results + headline + methodology. |
| `.work/` | Generated DBs + raw per-run JSON (git-ignored). |

## What's measured

- **prep+exec** (headline): `db.prepare(sql).all(...)` — app-faithful; `searchAssets()`
  compiles the statement fresh on every call.
- **exec-only**: statement pre-compiled, only `.all(...)` timed.
- Two timings per sample, `LIMIT 100 OFFSET 0`, 1,000 iters/query after 100 warmup.
- 24 queries: 10 single-term, 6 multi-term, 8 prefix — each verified to return hits.

Keep `lib/query.mjs` in sync if the BM25 weights or query construction in
`assets.ts` ever change, or the benchmark stops measuring the real query.
