# Omnidex v2.0.7 Release Notes

Omnidex is a local desktop app for organizing Unreal Engine assets. It is built with Electron 41 and React 19, talks to its main process over tRPC v11 (electron-trpc, serialized with superjson), and stores data in a local better-sqlite3 database. A small Rust napi-rs addon (`@omnidex/uasset`) parses `.uasset`/`.umap` files and extracts thumbnails.

## Build artifacts

This release ships a macOS arm64 build:

- `dist-installer/Omnidex-2.0.7-arm64.dmg`
- `dist-installer/Omnidex-2.0.7-arm64.zip`

Both are produced by `pnpm package:mac` (`scripts/package-mac.mjs`), which builds the napi addon for `aarch64-apple-darwin`, runs `electron-vite build`, then `electron-builder --mac --arm64`.

Windows (NSIS x64, `Omnidex-Setup-2.0.7.exe`) is built on a Windows host via `pnpm package` (`scripts/package-win.mjs`). The native modules cannot be cross-compiled from macOS, so a Windows installer is not produced from this Mac build. Intel/universal macOS and arm64 Windows are deferred.

## What the app does today

- Browse the asset grid (virtualized for large libraries).
- Inspect an asset: metadata, gallery, open file location or external URL.
- Filter, sort, and search: source filters (all, favorites, FAB, category, ecosystem), 14 sort options, debounced text search wired to the URL, favorite toggling.
- Manage collections: create, delete, add/remove assets.
- Manage scan locations: list, add via folder picker, pause/activate, and delete.
- Persist notes and settings.

## Known limitation: data operations are CLI-only

Scanning, thumbnail extraction, and FAB/Orbital enrichment are not wired into the running UI. The Settings "Scan now" button and the scan-progress panel are present but inert; adding a scan location does not start a scan. To populate or refresh the database, run the CLI scripts:

- `pnpm refresh-scans` — scan all active locations into the DB (`electron . --refresh-scans`).
- `pnpm extract-thumbs` — extract missing thumbnails via the napi addon (`electron . --extract-missing-thumbs`).
- `pnpm enrich-orbital` — match assets against orbital-market.com (`electron . --enrich-orbital`).
- `pnpm enrich-fab` — pull the user's FAB library over Epic OAuth and enrich matches (`electron . --enrich-fab`).

## Technology stack

- Desktop shell: Electron `^41.3.0`.
- UI: React `^19.2.5` with the React Compiler; TanStack Router and TanStack Query; Radix UI; Tailwind CSS v4.
- IPC: tRPC v11 over electron-trpc, serialized with superjson. The root router exposes `assets`, `scanLocations`, `collections`, `notes`, and `settings`.
- Storage: better-sqlite3 `^12.9.0`, with raw `.up.sql` migrations under `electron/main/db/migrations/` run by `electron/main/db/migrator.ts`. Search uses SQLite FTS5 plus `fuse.js`.
- Native addon: Rust napi-rs crate at `native/uasset/` (`uasset`, `image`, `flate2`).
- Bundler: electron-vite `^5.0.0` (Vite 7, SWC React plugin).
- Local files are served to the renderer through the privileged `omnidex-asset://` scheme.

## Building from source

Prerequisites: Node 24, pnpm `11.1.3` (pinned via `packageManager`), rustup (only to build the napi addon), and the platform toolchain (Xcode Command Line Tools on macOS, MSVC on Windows).

`git clone && pnpm install` is reproducible. The `postinstall` step downloads the Electron binary, rebuilds `better-sqlite3` and `keytar` to Electron's ABI, and applies the electron-trpc superjson patch.

Common scripts:

- `pnpm dev` — run the app (`electron-vite dev`).
- `pnpm build` — build main, preload, and renderer into `out/`.
- `pnpm check` — type-check (three tsconfigs, no emit).
- `pnpm lint` — Biome lint.
- `pnpm test:run` / `pnpm test:coverage` — Vitest.

CI is a single Ubuntu job (lint, type-check, unit tests, coverage). Installers are built manually: `pnpm package:mac` on a Mac, `pnpm package` on Windows.

## App identity

- appId: `com.umbralab.omnidex`, productName `Omnidex`.
- Publish target: GitHub `Umbra-Lab/Omnidex`.

## License

MIT License. See the LICENSE file.
