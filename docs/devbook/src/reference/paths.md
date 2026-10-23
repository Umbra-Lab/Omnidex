# Paths and files

## Runtime data

Everything Omnidex writes lives under Electron's `userData` directory. Resolved in `electron/main/db/paths.ts`.

| Platform | `userData` |
|---|---|
| Windows | `%APPDATA%\omnidex` |
| macOS | `~/Library/Application Support/omnidex` |
| Linux | `~/.config/omnidex` |

| Path | Contents |
|---|---|
| `omnidex.db` | The SQLite database, plus `-wal` and `-shm` |
| `thumbnails/` | Extracted PNGs |
| `search_index/` | Reserved |
| `logs/` | Application logs, and the Whisper backfill manifest |

```admonish danger title="The directory name depends on app.setName"
`app.setName('omnidex')` must run before `app.whenReady()`. Without it, dev, test, and packaged launches resolve *different* `userData` directories and therefore different databases.

The symptom is not an error — it is work that appears to vanish, because it landed in a second database. `pnpm audit:dbs` finds stray files.
```

## Repository layout

```
electron/
├── main/
│   ├── index.ts              bootstrap, CLI dispatch, omnidex-asset:// handler
│   ├── db/
│   │   ├── migrations/       36 .up.sql files
│   │   ├── migrator.ts
│   │   ├── paths.ts
│   │   └── repos/            the only place SQL lives
│   ├── trpc/
│   │   ├── router.ts         13 sub-routers
│   │   ├── routers/
│   │   ├── schemas.ts        Zod inputs
│   │   └── init.ts
│   ├── scanner/              walker, pipeline, manifests, thumbnails
│   ├── orbital/              marketplace client and enrichment
│   ├── fab/                  Epic FAB import and watcher
│   ├── ask/                  course question answering
│   ├── progress/             progressBus
│   ├── updates/              update-check state machine and settings
│   ├── ipc/                  legacy omnidex:* handlers
│   ├── native/
│   ├── asset-protocol.ts     range parsing
│   └── updater.ts
└── preload/index.ts          emits .cjs

renderer-react/src/
├── views/ features/ components/ui/
├── stores/ hooks/ ipc/ motion/ runtime/
└── router/index.tsx          hash history

native/uasset/                the only Rust
scripts/                      tooling, data ops, oracle-mcp, asr
shared/                       types used by both processes
docs/devbook/                 this book
```

## Build output

| Path | Contents |
|---|---|
| `out/main/index.mjs` | Main process bundle — what `electron .` runs |
| `out/main/migrations/` | Verbatim copy of the migration directory |
| `out/preload/index.cjs` | Preload |
| `out/renderer-react/` | Renderer bundle |
| `dist-installer/` | Packaged installers |

```admonish warning title="CLI flags run out/, not src"
A main-process change is invisible to `pnpm refresh-scans` until `pnpm build`. This includes new migrations, which are *copied* into `out/main/migrations/` at build time.
```

## The asset protocol

```
omnidex-asset://<url-encoded absolute path>
```

A privileged scheme registered in `electron/main/index.ts`. It is how the renderer reads any local file — thumbnails, video, audio, documents.

The handler supports range requests: `206 Partial Content` with `Content-Range` for a valid range, `416` with `bytes */size` for an unsatisfiable one, and `Accept-Ranges: bytes` on every response.

```admonish note title="Range support is what makes video seekable"
Chromium's media pipeline will not seek in a resource served without range support, so playback position cannot be restored. This is a correctness requirement, not an optimization.
```

Range parsing is in `electron/main/asset-protocol.ts`, deliberately separated so it is unit-testable. It validates digits only — `Number()` alone accepts exponent notation, so `bytes=-1e3` would otherwise parse as valid — and returns `null` for multi-range requests rather than mishandling them.

## Configuration files

| File | Purpose |
|---|---|
| `package.json` | Scripts, dependencies, `build` (electron-builder) |
| `biome.json` | Lint and format rules |
| `electron.vite.config.ts` | Build config for all three targets |
| `vitest.config.ts` | Unit test config |
| `playwright.config.ts` | End-to-end config |
| `.nvmrc` | Node 24 |
| `patches/` | Applied by `pnpm apply-patches` |

## Next steps

- [Commands](commands.md) — what produces these outputs
- [The database](../subsystems/database.md) — what lives in `omnidex.db`
