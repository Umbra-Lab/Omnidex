# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Omnidex is an Electron 41 + React 19 desktop app that indexes local Unreal Engine asset packs and video courses into a searchable SQLite library. Depth lives in `docs/devbook/` (mdBook, the only curated docs — start at `src/SUMMARY.md`); this file is the orientation and the traps the devbook doesn't lead with.

## Commands

pnpm only (`packageManager` pins `pnpm@11.1.3`, Node `>=24`, `.nvmrc` = 24). Never `npm`.

```bash
pnpm install         # postinstall: ensure-uasset --soft → ensure-electron → electron-rebuild (better-sqlite3, keytar) → apply-patches
pnpm dev             # capsize CSS, then electron-vite dev (renderer HMR on 127.0.0.1:5174; main-process edits need a restart)
pnpm build           # capsize CSS, then electron-vite build → out/ (main .mjs, preload .cjs, out/renderer-react, copied migrations)
pnpm preview         # run the built app
pnpm check           # tsc --noEmit over electron/tsconfig.main.json, tsconfig.preload.json, renderer-react/tsconfig.json (no Biome)
pnpm lint            # biome lint ./electron ./renderer-react ./shared ./scripts
pnpm format          # biome format --write, same four dirs
pnpm lint:fix        # biome check --write, same four dirs (lint + format + import sort); lint:fix:unsafe adds --unsafe
pnpm test:run        # vitest, once (pnpm test = watch; pnpm test:coverage = what CI runs)
pnpm build:uasset    # build the napi addon (needs rustup); pnpm ensure:uasset copies/builds only if no .node exists
pnpm run rebuild     # electron-rebuild for better-sqlite3 + keytar
pnpm apply-patches   # re-apply the electron-trpc patch
```

- `pnpm lint:fix` applies safe fixes only. `pnpm lint:fix:unsafe` adds `--unsafe`, which can change behavior, so read the diff.
- Use `pnpm run rebuild`, not `pnpm rebuild`: the latter is pnpm's built-in, which targets system-Node ABI.
- Run Electron-touching commands through the `pnpm` scripts. `scripts/run-electron.mjs` deletes `ELECTRON_RUN_AS_NODE` (VS Code sets it, and Electron then runs as plain Node).
- `pnpm-workspace.yaml` gets an `allowBuilds:` stub appended on every install. It is not committed; delete it if it shows in `git status`.

### Tests

```bash
pnpm exec vitest run electron/main/db/repos/__tests__/tags.test.ts   # one file
pnpm exec vitest run electron/main/db/repos/__tests__/tags.test.ts -t "name fragment"   # one test
pnpm build && pnpm test:electron tests/electron-search.spec.ts       # one Playwright spec (needs out/)
node scripts/oracle-mcp/server.test.mjs [path-to-omnidex.db]         # oracle MCP self-check
```

- Vitest (`vitest.config.ts`): jsdom, discovers only `renderer-react/src`, `shared`, `electron` (`*.test|spec`); `tests/` is Playwright's. `electron` is aliased to `electron/test-stubs/electron.ts`, so no Electron binary is needed.
- DB tests use Node's built-in `node:sqlite` with fixtures in `electron/main/db/repos/__tests__/fixtures/`, not `better-sqlite3` (Electron ABI). CI sets `NODE_OPTIONS=--experimental-sqlite` on the test step only.
- Opt-in suites that skip by default: `OMNIDEX_TEST_UASSET=1` (real addon), `OMNIDEX_TEST_CLAUDE_CODE=1` (Ask provider), `POOL_LIVE_LIST=<json>` (`scanner/__tests__/pool-live.local.test.ts`).
- Playwright (`playwright.config.ts`) launches `out/main/index.mjs` per spec against the real userData library, `workers: 1`. Parallel launches die because every launch shares one userData dir.
- `server.test.mjs` runs against a real DB (default `%APPDATA%/omnidex/omnidex.db`). Neither vitest nor CI runs it.
- Coverage is scoped to eight named modules with 90/85/95/90 thresholds (`vitest.config.ts`).

### Data operations (headless)

Each flag boots Electron through the normal startup path, runs the job, and quits. Run `pnpm build` first (`main` is `out/main/index.mjs`).

```bash
pnpm refresh-scans | extract-thumbs | enrich-orbital | enrich-fab | backfill:course-sources
```

`enrich-fab` also takes `--fab-token <bearer>` and `--fab-account <id>`. The flag dispatch is at the top of `electron/main/index.ts`, and `docs/devbook/src/reference/cli-flags.md` lists all of them. The UI reaches the same services (Settings → scan/enrich buttons, Command Palette) with live progress.

Helpers: `pnpm inspect-db`, `pnpm audit:dbs`, `pnpm bench:search` (Electron-as-node, needs the live DB), `pnpm smoke:scan <path>` and `pnpm gen:test-library [dir]` (plain Node), `pnpm remux`, `pnpm notices[:check]`. `scripts/asr/backfill.py` is separate Python (faster-whisper, CUDA); see `docs/devbook/src/guides/transcribe-a-course.md`.

### Hooks and CI

- `.husky/pre-commit` runs `pnpm biome check --write --staged --no-errors-on-unmatched`. Unfixable violations block the commit. Biome writes its fixes to the working tree without staging them, so run `pnpm lint:fix` before committing. `pnpm install` wires the hook: `prepare` runs `husky`, which sets `core.hooksPath` to `.husky/_`. `--ignore-scripts` skips it; run `pnpm exec husky` by hand.
- `.github/workflows/ci.yml` (push and PR to `main`, one Ubuntu job): `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm lint`, `pnpm check`, `pnpm test:coverage`. It builds no installers by design.
- Commits follow Conventional Commits (`feat(scope):`, `fix(scope):`, `docs(scope):`).

## Architecture

**Boundaries.** Main (`electron/main/`, ESM → `out/main/index.mjs`) owns the database, filesystem, network and every long job. Preload (`electron/preload/index.ts`, CJS) calls `exposeElectronTRPC()`, then exposes the legacy `window.omnidex` bridge. The renderer (`renderer-react/`, Vite with `@vitejs/plugin-react` and the React Compiler, TanStack Router on hash history) holds no authoritative state. Shared types are in `shared/types` (`@omnidex/types`). Overview: `docs/devbook/src/orientation/architecture.md`.

**One data path.** Renderer → `electron-trpc` + superjson → `electron/main/trpc/router.ts`, which mounts 13 sub-routers from `trpc/routers/` (assets, scanLocations, collections, courses, notes, settings, scanner, orbital, fab, libraryHealth, progress, ask, updates). Routers call the repo layer in `electron/main/db/repos/`; none touches SQL. New renderer data access is a tRPC procedure (`docs/devbook/src/guides/add-a-trpc-procedure.md`). `window.omnidex` and `electron/main/ipc/` (`omnidex:*` channels) remain for shell, dialog, menu, events and platform calls; don't extend them for data.
- `patches/electron-trpc@1.0.0-alpha.0.patch` adds superjson. Without it every call throws `reading 'serialize'`. pnpm 11 ignores `patchedDependencies`, so `scripts/apply-patches.mjs` applies it at install.
- That patch bypasses tRPC's `errorFormatter`: custom `data` on a thrown `TRPCError` never reaches the renderer. Return the detail in the result instead.
- `patches/electron-trpc@1.0.0-alpha.0.same-document-navigation.patch` stops electron-trpc closing a frame's subscriptions on hash-route changes. Without it `AppShell`'s once-at-mount `progress.onProgress` subscription dies at the first navigation and the scan progress panel goes silent. `apply-patches.mjs` applies each `<pkg>@<version>[.<topic>].patch` on its own, so add a new fix as a new file rather than amending an applied one.

**Startup and state.** `electron/main/index.ts` pins `app.setName('omnidex')` first, so dev, test and packaged runs share one userData dir and one `omnidex.db` (`db/paths.ts`). It also holds the single-instance lock (a second launch exits) and registers the privileged `omnidex-asset://` protocol, which serves local files only under userData or an active scan root.

**Database.** `better-sqlite3` with a custom migrator (`db/migrator.ts`). Migrations are `db/migrations/<YYYYMMDDHHMMSS>_<name>.up.sql`, up-only, tracked in `_omnidex_migrations`. Each pending run takes a backup first, and the build copies them to `out/main/migrations`. FTS5 tables are `assets_fts` and `transcript_fts`. See `guides/write-a-migration.md` and `reference/schema.md`.

**Scan pipeline.** `scanner/` (walker → ecosystem detection → name resolver → `asset-upsert` → `pipeline`, driven by `refresh-all`) writes through the repos. Thumbnails run afterward as a background job in disposable child processes (`scanner/thumbnail-pool.ts`): the `uasset` crate calls `abort()` on malformed headers, which no `try/catch` can stop. `native/uasset` is the only Rust (napi-rs). `index.js` and `index.d.ts` are committed, `*.node` is gitignored, and the root package depends on it as `file:native/uasset`. Packaging must build and sync it into `node_modules/@omnidex/uasset`. `postinstall` and every app launch (`run-electron.mjs` for `electron .` and `electron-vite dev|preview`, Playwright `globalSetup`) run `scripts/ensure-uasset.mjs` first, so Electron never starts without the binary.

**Progress.** Long actions (`refresh-scans`, `enrich-orbital`, `enrich-fab`) publish to `progress/bus.ts`. The CLI logger and the `progress.onProgress` tRPC subscription both read it, so headless and UI runs share one service layer.

**Enrichment, Ask, Learn.** `orbital/` is a rate-limited Orbital Market client with a cache. `fab/` imports the Epic FAB library (OAuth; stale credentials surface as an auth-required result) and watches the local vault. `ask/` calls a local OpenAI-compatible server on `:8080` or headless `claude -p`, main process only. `scanner/course-manifest.ts` walks course folders (videos, duration, subtitles), subtitle sidecars are indexed into `transcript_fts`, and `scanner/subtitles.ts` serves `.srt` to the player as WebVTT. `scripts/asr/backfill.py` writes the `.srt` sidecars that a later scan picks up.

**Renderer.** Routes in `renderer-react/src/router/index.tsx`: `/`, `/assets`, `/collections`, `/collections/$collectionId`, `/match`, `/learn`, `/health`, `/settings`, `/settings/$tab`. Zustand slices are in `stores/`. Radix primitives are wrapped in `components/ui/`. Tailwind v4.

**Oracle MCP server** (`scripts/oracle-mcp/server.mjs`). Zero-dependency stdio JSON-RPC MCP server on `node:sqlite`. It opens `omnidex.db` read-only (`ORACLE_DB`, default `%APPDATA%/omnidex/omnidex.db`) and exposes search and lookup tools over transcripts, lessons, courses and owned assets (BM25 on `assets_fts`). It does not need Electron. Register it per user with `claude mcp add omnidex-oracle -- node <repo>/scripts/oracle-mcp/server.mjs`. When the tool set changes, update its page (`subsystems/oracle-mcp.md`) and `server.test.mjs`, which asserts tool names.

## Release

Installers are built by hand on the target OS. There is no release workflow.
- `pnpm package` (Windows x64, NSIS `Omnidex-Setup-<version>.exe`, exits on other hosts) and `pnpm package:mac` (arm64 `.dmg` + `.zip`, darwin only; `--universal` adds x64).
- Order: regenerate `THIRD-PARTY-NOTICES.md` → icons → build addon → sync it into `node_modules` → (Windows only) `electron-rebuild` → `pnpm build` → `electron-builder`. Output goes to `dist-installer/`.
- `pnpm release` and `pnpm release:mac` add `--publish always` (GitHub `Umbra-Lab/Omnidex`; needs `GH_TOKEN`, plus `CSC_*` and `APPLE_*` for mac signing). Unsigned mac builds set `CSC_IDENTITY_AUTO_DISCOVERY=false`. The version comes only from `package.json`.
- Update checks are opt-in (`updates.auto_check`, off by default) and installed builds only. macOS cannot install an update in place until builds are signed and notarized, so don't turn the default on before that: see `docs/devbook/src/subsystems/updates.md`. PRIVACY.md section 3 and Settings → About describe the check and change with it.
- Steps and troubleshooting: `DEPLOYMENT.md`, `docs/MACOS-BUILD.md`, `docs/devbook/src/guides/package-a-release.md`.

## Docs and conventions

- **Devbook:** `cd docs/devbook && mdbook serve --open` (needs `mdbook`, `mdbook-mermaid`, `mdbook-admonish`). Rules are in `docs/devbook/src/standards/documentation.md`: one Diátaxis mode per page, add exactly one line to `SUMMARY.md`, run `mdbook build` and read the `[WARN]` lines (dead links don't fail it), and curate rather than archive. Outside the devbook, `docs/` holds only `MACOS-BUILD.md` and a dated library-scale audit; planning and audit material stays out of the repo.
- **Style:** Biome 2.3.12 — 2 spaces, single quotes, trailing commas, 100 columns; `noExplicitAny` warns, `useConst` is off. No ESLint or Prettier.
- **Design system:** `DESIGN.md` is the spec, and `renderer-react/src/styles/global.css` must mirror it. OKLCH tokens, a single orange accent for primary actions, mono for every numeric value, exact counts (`2,799`, never `2.8K`), radius never above 6px, no shadows on content cards. Type sizes use the generated Capsize `cap-N` classes (`pnpm capsize`).
