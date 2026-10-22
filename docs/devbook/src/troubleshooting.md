# Troubleshooting

Symptoms and their causes, grouped by where they surface.

## Install and build

| Symptom | Cause | Fix |
|---|---|---|
| `Could not locate the bindings file` | `pnpm install --force` reset `better-sqlite3` to the system Node ABI | `pnpm run rebuild` |
| Every tRPC call throws `reading 'serialize'` | The electron-trpc superjson patch is not applied | `pnpm apply-patches` |
| Scan progress (or an Ask answer) stops arriving after you change route | The electron-trpc same-document-navigation patch is not applied, so the first route change closed the subscription | `pnpm apply-patches` |
| Electron binary missing after install | `ensure-electron.mjs` did not run | `node scripts/ensure-electron.mjs` |
| `[ensure-uasset] ERROR: no cargo on PATH` from `pnpm dev`, `pnpm preview` or `pnpm test:electron` | `native/uasset/*.node` is missing and there is no Rust toolchain to build it | Install rustup, open a new shell, run `pnpm ensure:uasset` |
| `[ensure-uasset] WARNING: … older than the addon sources` | The binary was built before the last change to `native/uasset` | `pnpm build:uasset` |
| `[ensure-electron] ERROR: dist/ still missing`, with only `locales/` unpacked | Node newer than 24; Electron's unzip step breaks under Node 26 | Switch to Node 24 (`.nvmrc`) and reinstall |
| `Cannot find native binding` in CI | A module that imports `@omnidex/uasset` got pulled into a test path | Import the dependency-free module instead — see `scanner/asset-upsert.ts` |
| `pnpm-workspace.yaml` shows an `allowBuilds:` block | pnpm 11.1.3 appends a harmless stub | Delete it; it is not committed |
| A CLI flag runs old behaviour | Flags run `out/`, not source | `pnpm build` |
| A new migration does not apply | Migrations are *copied* into `out/main/migrations/` at build time | `pnpm build` |

```admonish danger title="pnpm rebuild is not pnpm run rebuild"
`pnpm rebuild` is pnpm's built-in and rebuilds everything. `pnpm run rebuild` is this repo's script, which rebuilds `better-sqlite3` and `keytar` against Electron's ABI. Only the second one is what you want.
```

## Scanning

| Symptom | Cause |
|---|---|
| A folder is missing from the library | Check `scan_diagnostics` for that path first — most skips are recorded with a reason |
| Nine "courses" named after disciplines | The course location points at a category folder. Point it at each discipline instead. |
| A course registered its sample project as a separate pack | The location has no `content_format`, so flat mode is off |
| Deleted packs still appear | The scan aborted or crashed before the reconciliation prune, or the location is inactive |
| A scan dies partway with a huge number in the message | A Rust allocation abort in the `.uasset` parser. See below. |

### `memory allocation of N bytes failed`

```
memory allocation of 5857542141 bytes failed
[ELIFECYCLE] Command failed with exit code 3221226505
```

The upstream `uasset` crate sized an allocation from a malformed package header. A failed allocation in Rust calls `abort()`, which no `try`/`catch` and no timeout can intercept.

This should no longer reach the scan — extraction runs in child processes (`thumbnail-pool.ts`). If you see it, something is calling `extractThumbnail` in-process. See [The uasset addon](subsystems/native-uasset.md).

### `VirtualAlloc failed` at startup

The machine is out of committable memory at that instant, usually because several heavy processes overlapped. Not an application bug. Retry.

## Transcripts and Learn

| Symptom | Cause |
|---|---|
| A course lost its transcripts | A scan was killed during the manifest phase. Cues cascade from `course_files`; run a complete scan to rebuild them from the `.srt` files on disk. |
| Orphan cues exist | The `AFTER DELETE` trigger or the foreign key is missing. `SELECT COUNT(*) FROM transcript_cues WHERE file_id NOT IN (SELECT id FROM course_files)` must return `0`. |
| Video will not seek; resume always starts at 0 | The asset protocol is not answering range requests with `206` |
| A lesson shows the wrong language subtitles | Two sidecars exist and the English-tagged one is not being preferred |
| A video will not play at all | The container is one Chromium rejects, usually MPEG-2 TS. Run `pnpm remux`. |
| Transcript search returns text from a deleted lesson | Stale FTS rows — the external-content index was written without its triggers |

## Search

| Symptom | Cause |
|---|---|
| Transcript search is slow | Check that `transcript_cues` has its `(file_id, start_ms)` index and that queries join through `transcript_fts` rather than filtering FTS columns |
| Ranking feels wrong | Check for orphan cues. BM25 computes IDF over the whole corpus, so stale duplicates degrade ranking for everything. |

## Database

| Symptom | Cause |
|---|---|
| Work appears to have vanished | Two `userData` directories. `app.setName('omnidex')` must run before `app.whenReady()`. Run `pnpm audit:dbs`. |
| A migration failed | It rolled back; the error names the file. Fix forward — there are no down migrations. |
| Database file did not shrink after a big delete | `VACUUM` cannot run inside the migrator's transaction. Free pages are reused by later growth. |

## ASR

| Symptom | Cause |
|---|---|
| The run sits doing nothing | The GPU co-residency guard is waiting for VRAM below 4,500 MiB. Check `nvidia-smi`. |
| `ModuleNotFoundError: faster_whisper` | Wrong interpreter. Use the venv's `python.exe` explicitly. |
| Translation never starts | It is queued behind transcription in path order. Use `--only translate`. |

## Tests

| Symptom | Cause |
|---|---|
| A test passes but the feature is broken | Check the [false-green traps](standards/testing.md#traps-that-have-produced-false-greens) — virtualized counts, length assertions, stub payloads |
| CI is "green" but suspicious | Confirm a run actually happened. Check dates, not status. |
| An access violation ends a local test run | Usually machine load, not a defect. Re-run before investigating. |

## Next steps

- [Testing](standards/testing.md) — how these get caught earlier
- [Commands](reference/commands.md) — the diagnostic tooling
