# Commands

Every script in `package.json`. Many wrap their tool through `scripts/run-electron.mjs`, which resolves the Electron binary consistently across platforms.

## Develop

| Command | Does |
|---|---|
| `pnpm dev` | `electron-vite dev` with renderer hot reload. Main-process changes need a restart. |
| `pnpm build` | Production build to `out/` — main `.mjs`, preload `.cjs`, renderer bundle, and a verbatim copy of `db/migrations/` |
| `pnpm preview` | Run the built output |
| `pnpm capsize` | Regenerate Capsize typography metrics |

## Verify

| Command | Does |
|---|---|
| `pnpm check` | `tsc --noEmit` across the main, preload, and renderer tsconfigs. Types only — no linting. |
| `pnpm lint` | Biome lint over `electron`, `renderer-react`, `shared`, `scripts` |
| `pnpm lint:fix` | `biome check --write` — safe fixes, formatting, and import sorting |
| `pnpm lint:fix:unsafe` | `biome check --write --unsafe` — also applies fixes that can change behavior. Review the diff. |
| `pnpm format` | `biome format --write` |
| `pnpm test` | Vitest in watch mode |
| `pnpm test:run` | Vitest once |
| `pnpm test:coverage` | Vitest with coverage — what CI runs |
| `pnpm test:electron` | Playwright end-to-end against a real Electron window |

## Data operations

Each boots Electron, runs the job, and exits. All require a prior `pnpm build`.

| Command | Flag | Does |
|---|---|---|
| `pnpm refresh-scans` | `--refresh-scans` | Scan every active location |
| `pnpm extract-thumbs` | `--extract-missing-thumbs` | Extract thumbnails still missing |
| `pnpm enrich-orbital` | `--enrich-orbital` | Match packs against Orbital Market |
| `pnpm enrich-fab` | `--enrich-fab` | Sync the Epic FAB library |
| `pnpm backfill:course-sources` | `--backfill-course-sources` | Fill `tutorial_source` for existing courses |

## Diagnostics

| Command | Does |
|---|---|
| `pnpm inspect-db` | Dump database contents |
| `pnpm audit:dbs` | Find stray database files across `userData` directories |
| `pnpm bench:search` | Search latency benchmark |
| `pnpm smoke:scan <path>` | Walker dry run. Prints detected folders, writes nothing. |
| `pnpm gen:test-library [dir]` | Generate a synthetic Unreal library (default `./test-library`) |
| `pnpm remux` | Convert unplayable containers to MP4 by stream copy |

`smoke:scan` and `gen:test-library` are plain Node and do not boot Electron.

```admonish note title="Colons in script names, hyphens in files"
`pnpm smoke:scan` runs `scripts/smoke-scan.mjs`; `pnpm gen:test-library` runs `scripts/gen-test-library.mjs`.
```

## Native and install

| Command | Does |
|---|---|
| `pnpm build:uasset` | Build the napi addon |
| `pnpm ensure:uasset` | Copy or build the addon binary if none exists. Runs in `postinstall` and before every app launch |
| `pnpm run rebuild` | Rebuild `better-sqlite3` and `keytar` for Electron's ABI |
| `pnpm apply-patches` | Reapply `patches/` — notably the electron-trpc superjson patch |

```admonish danger title="pnpm rebuild is a different command"
`pnpm rebuild` is pnpm's built-in and rebuilds every native module. `pnpm run rebuild` is this repo's script. They are not interchangeable.
```

## Package

| Command | Does |
|---|---|
| `pnpm package` | Windows NSIS x64 installer. Windows host only. |
| `pnpm release` | Same, with `--publish` |
| `pnpm package:mac` | macOS arm64 `.dmg` and `.zip` |
| `pnpm release:mac` | Same, with `--publish` |
| `pnpm notices` | Regenerate third-party notices |
| `pnpm notices:check` | Fail if notices are stale |

## What CI runs

`.github/workflows/ci.yml` is a single Ubuntu job:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

then `pnpm lint`, `pnpm check`, `pnpm test:coverage`.

`--ignore-scripts` means no native rebuild, which is why unit tests use `node:sqlite` rather than `better-sqlite3`. It also skips `prepare`, so CI installs no Git hook. There is no packaging job.

```admonish warning title="Check CI run dates, not just status"
A branch-filter mismatch produces no failing run — it produces *no run at all*, which reads as green. This repository once ran nothing for five weeks after a `master` → `main` rename. When verifying CI, look at when the last run happened.
```

## Next steps

- [CLI flags](cli-flags.md) — the underlying flags
- [Run a data operation](../guides/run-a-data-operation.md) — using them
