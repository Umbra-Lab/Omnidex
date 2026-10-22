# Omnidex

Omnidex is a desktop app for indexing and browsing local Unreal Engine and FAB marketplace asset libraries. It scans the folders where you keep your `.uasset`/`.umap` packs, extracts thumbnails from them, and enriches each pack with metadata from orbital-market.com and your Epic/FAB library so you can search, filter, and organize the whole collection in one place.

It is built with Electron 41 and React 19. The main process talks to the renderer over tRPC (via electron-trpc + superjson), stores everything in a local better-sqlite3 database, and reads Unreal asset files through a Rust napi addon (`@omnidex/uasset`).

Omnidex is free and open source under the MIT license. Use it, fork it, change it, ship it. If it saves you time, you can [sponsor the project](https://github.com/sponsors/figgiee).

## Download

Installers for Windows and macOS are published on the [Releases page](https://github.com/Umbra-Lab/Omnidex/releases). The builds are not code-signed yet: Windows SmartScreen asks you to confirm the first launch, and macOS needs a right-click → **Open**. To build from source instead, follow the quick start below.

## Quick start

Prerequisites:

- **Node 24** (`.nvmrc` pins `24`)
- **pnpm 11.1.3** (pinned in `package.json` via `packageManager`)
- **Rust** (rustup) to build the `native/uasset` napi addon
- **Xcode Command Line Tools** on macOS to compile native modules

```bash
pnpm install
pnpm dev
```

`pnpm install` runs a `postinstall` step that copies or builds the `native/uasset` addon binary, downloads the Electron binary, rebuilds the native modules (`better-sqlite3`, `keytar`) against Electron's ABI, and applies the bundled `electron-trpc` patch. A fresh clone needs no manual steps after `pnpm install`.

`pnpm dev` launches the app through `electron-vite dev`.

## Common scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run the app in development (`electron-vite dev`). |
| `pnpm build` | Build main, preload, and renderer into `out/`. |
| `pnpm check` | Type-check the three tsconfigs (main / preload / renderer), no emit. |
| `pnpm lint` | Lint with Biome. |
| `pnpm test:run` | Run the Vitest unit suite once. |
| `pnpm run rebuild` | Rebuild `better-sqlite3` and `keytar` against Electron's ABI. |

## Building installers

Installers are built locally on the target platform. There is no cross-compilation, because the native modules need a real host toolchain.

**macOS (arm64):**

```bash
pnpm package:mac
```

This builds the napi addon for `aarch64-apple-darwin`, runs `pnpm build`, then packages with electron-builder. Output lands in `dist-installer/` as `Omnidex-<version>-arm64.dmg` and a matching `.zip`. The shipped target is arm64 only; an Intel/universal build is deferred behind a `--universal` flag.

**Windows (x64):**

```bash
pnpm package
```

`scripts/package-win.mjs` must run on Windows — it guards against other platforms and needs MSVC to build the addon (`x86_64-pc-windows-msvc`) and rebuild native modules. Output is an NSIS installer, `Omnidex-Setup-<version>.exe`.

## Current status

Scanning and enrichment run from inside the app, with live progress. The CLI flags run the same services headless.

**In the app:**

- **Scan one folder:** Settings → Folders → **Scan** on the folder's row.
- **Scan every active folder:** Settings → Folders → **Scan all**, or the Command Palette (Ctrl+K, ⌘K on macOS) → **Refresh library**.
- **Progress and cancel:** the folder row shows progress, and the floating scan panel shows it too, with a cancel button.
- **Thumbnails:** extracted automatically in the background after each scan.
- **Orbital enrichment:** Settings → Marketplace → **Enrich now**.
- **FAB library sync:** Settings → Marketplace → **Sync now**, plus a toggle that watches the FAB vault for new downloads.

The first folder you add in the onboarding dialog is scanned immediately. A folder you add or edit under Settings → Folders is saved but not scanned until you choose **Scan** or **Scan all**.

Not wired yet: correcting an asset's Orbital match from the inspector, and automatic enrichment after a scan (the **Auto-match on scan** switch is disabled).

**Headless (CLI):** each flag boots the built app (`out/`, so run `pnpm build` first), runs the job, and exits.

```bash
pnpm refresh-scans      # scan all active scan locations into the DB
pnpm extract-thumbs     # extract missing thumbnails from .uasset files
pnpm enrich-orbital     # match assets against orbital-market.com
pnpm enrich-fab         # pull your FAB library (Epic OAuth) and enrich matches
```

The full flag list is in [`docs/devbook/src/reference/cli-flags.md`](./docs/devbook/src/reference/cli-flags.md).

What else the UI does today: browse the virtualized asset grid, inspect an asset (metadata, gallery, open file location or external URL), filter and sort, full-text search, manage collections, and manage scan locations (add, edit, pause or activate, delete).

## Project layout

- `electron/main/` — main process: tRPC routers, the SQLite migrator and `.up.sql` migrations, CLI job handlers, the `omnidex-asset://` protocol.
- `electron/preload/` — context bridge and electron-trpc setup.
- `renderer-react/` — the React 19 + TanStack Router/Query frontend.
- `native/uasset/` — the Rust napi addon (`rust-version = "1.88"`) that parses Unreal asset files and extracts thumbnails.
- `scripts/` — packaging, install, and data-op helpers.

## Privacy & data

Omnidex is local-first and ships with **no telemetry or analytics**. To enrich
your assets it sends asset **names** to `orbital-market.com` (a community
catalog mirror, not affiliated with Epic/FAB) and, if you connect your Epic
account, uses your **own** Epic login to fetch your **own** owned FAB library.
Exactly what data leaves your machine — and what does not — is documented in
[`PRIVACY.md`](./PRIVACY.md). The in-app **Settings → About** tab summarizes the
same disclosure.

## Third-party services

Omnidex is an unofficial community tool. It is not affiliated with, endorsed by, or supported by Epic Games, Fab, Unreal Engine, or Orbital Market. The FAB library sync signs in to your own Epic account and reads your own library; the Orbital enrichment reads public product listings at a throttled rate. Both depend on endpoints these services do not document, so either can stop working without notice. Use them with your own account only.

## Contributing and support

Bug reports, feature ideas and pull requests are welcome: see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Report security issues privately as described in [`SECURITY.md`](./SECURITY.md).

Omnidex is built and maintained in spare time. If it helps your work, [sponsoring on GitHub](https://github.com/sponsors/figgiee) keeps it going.

## License & terms

MIT — see [`LICENSE`](./LICENSE). Plain-language end-user terms are in
[`EULA.md`](./EULA.md), and the data/privacy disclosure is in
[`PRIVACY.md`](./PRIVACY.md).

The packaged app bundles JetBrains Mono (SIL OFL 1.1), the Archivo
typeface (Omnibus-Type, SIL OFL 1.1) and its production npm
dependencies. The open-source attributions and full license texts are
aggregated in
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md), which is generated from the
production dependency tree and ships inside the installer. Regenerate it after
changing dependencies:

```bash
pnpm notices            # rewrite THIRD-PARTY-NOTICES.md
pnpm notices:check      # CI guard: fails if it is stale
```

The macOS and Windows packaging scripts regenerate it automatically before each
build, and electron-builder copies it (plus `LICENSE`) into the app's resources.
