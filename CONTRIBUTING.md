# Contributing to Omnidex

Omnidex is an Electron + React desktop app. The main process and IPC live in `electron/`, the React renderer in `renderer-react/`, shared types in `shared/`, and build/data scripts in `scripts/`. The only Rust in the repo is the native napi-rs addon at `native/uasset/` (parses Unreal `.uasset`/`.umap` files and extracts thumbnails).

## Prerequisites

- **Node 24** (`.nvmrc` pins `24`; `engines.node` is `>=24`).
- **pnpm 11.1.3**, pinned via `packageManager` in `package.json`. Corepack will pick this up automatically.
- **Rust (rustup)** with toolchain `1.88` or newer. Only required to build the `native/uasset` addon.
- **Xcode Command Line Tools** on macOS (needed to compile native modules and rebuild for Electron's ABI).

## Setup

```bash
pnpm install
```

That's the whole setup. `postinstall` runs four steps automatically:

1. `scripts/ensure-uasset.mjs --soft` makes sure the `native/uasset` addon binary exists, by copying it from another worktree with identical addon sources or building it with cargo. Without Rust it warns and the install continues.
2. `scripts/ensure-electron.mjs` downloads and unpacks the Electron binary into `node_modules/electron/dist`.
3. `electron-rebuild -f -w better-sqlite3,keytar` rebuilds those native modules against Electron's ABI.
4. `scripts/apply-patches.mjs` applies the `electron-trpc` patch that wires superjson into the transformer. Without it every tRPC call fails with `Cannot read properties of undefined (reading 'serialize')`. The script is idempotent and safe to re-run.

If you need to rebuild native modules by hand later, run `pnpm run rebuild`. Do not run `pnpm rebuild`: that is pnpm's built-in, which rebuilds every native module for the system Node ABI instead of Electron's.

## Dev loop

```bash
pnpm dev
```

This runs `electron-vite dev` (through `scripts/run-electron.mjs`) and launches the app with hot reload for the main, preload, and renderer targets.

`pnpm build` produces the production bundle in `out/`. `pnpm preview` runs the built app.

## Code quality and tooling

This project uses **Biome (`@biomejs/biome` 2.3.12)** for linting and formatting across `electron`, `renderer-react`, `shared`, and `scripts`. There is no ESLint or Prettier.

| Command | What it does |
|---|---|
| `pnpm lint` | Lint the four source directories. |
| `pnpm format` | Format the four source directories in place. |
| `pnpm lint:fix` | Run `biome check --write`: safe lint fixes, formatting, and import sorting. |
| `pnpm lint:fix:unsafe` | Run `biome check --write --unsafe`. Review the diff, because unsafe fixes can change behavior. |
| `pnpm check` | Type-check only. Runs `tsc --noEmit` across the main, preload, and renderer tsconfigs. This is **not** a Biome command. |

### Code style

Enforced by `biome.json`:

- Indentation: 2 spaces.
- Line width: 100 characters.
- Quotes: single quotes for JavaScript/TypeScript.
- Trailing commas: always where valid.
- `noExplicitAny` is a warning; `useConst` is off.

### IDE integration (optional)

Install the official `biomejs.biome` extension for VS Code or Cursor to get format-on-save, organize-imports-on-save, and inline lint diagnostics. The repo ships workspace settings in `.vscode/settings.json` that set Biome as the default formatter.

## Git hooks

`pnpm install` wires the pre-commit hook. The root `prepare` script runs `husky`, which sets `core.hooksPath` to `.husky/_`; that directory forwards each Git hook to the matching script in `.husky/`. `.husky/pre-commit` runs:

```bash
pnpm biome check --write --staged --no-errors-on-unmatched
```

Any lint or format violation that Biome cannot fix **blocks the commit**. `--no-errors-on-unmatched` lets a commit through when it stages no file Biome handles, such as a docs-only or migration-only change.

Biome writes its safe fixes to your working tree but does not stage them. A commit that needed a fix still goes through with the original text, and the fix shows up afterward as an unstaged change. Run `pnpm lint:fix` before you commit, or stage the fixes and amend.

`prepare` runs after `postinstall`, and `pnpm install --ignore-scripts` skips it. If either leaves the hook unwired (`git config core.hooksPath` prints nothing), run `pnpm exec husky`.

## Tests

```bash
pnpm test            # vitest in watch mode
pnpm test:run        # vitest, single run
pnpm test:coverage   # vitest with coverage (what CI runs)
pnpm test:electron   # Playwright end-to-end against the built app in out/
```

`pnpm test:electron` launches `out/main/index.mjs`, so run `pnpm build` first or it tests the previous build. Each spec runs against your real userData library, one worker at a time, because every launch shares one userData directory.

## Native addon (`native/uasset`)

The `@omnidex/uasset` addon is a napi-rs `cdylib` crate. `pnpm install` provides its binary (see Setup). After you change its sources, rebuild it with:

```bash
pnpm build:uasset
```

No compiled `.node` is checked in: `native/uasset/.gitignore` excludes `*.node`. Only the source, `index.js`, and `index.d.ts` are committed, so a fresh clone type-checks without Rust but cannot load the addon until the binary exists. `pnpm dev`, `pnpm preview`, the headless data scripts and `pnpm test:electron` run `pnpm ensure:uasset` first and stop with an error if the binary is missing and cannot be built, rather than launching Electron into a "Cannot find native binding" dialog. This crate is the only Rust in the repo. There is no app-level Rust backend, no Cargo workspace, and no root `Cargo.toml`, so the project has no Clippy step.

## Database

The local store is `better-sqlite3`. Migrations are raw `.up.sql` files under `electron/main/db/migrations/`, applied by the custom migrator in `electron/main/db/migrator.ts`. To add a migration, create a new timestamped `*.up.sql` file in that directory.

## Data operations (headless)

Scanning, enrichment, and thumbnail extraction run from the UI (Settings → Folders, Settings → Marketplace, the Command Palette) and as one-shot CLI jobs that use the same services. Each CLI flag boots the built app in `out/`, so run `pnpm build` first.

| Command | What it does |
|---|---|
| `pnpm refresh-scans` | Scan all active filesystem locations into the DB. |
| `pnpm extract-thumbs` | Extract missing thumbnails from `.uasset` files via the addon. |
| `pnpm enrich-orbital` | Match assets against orbital-market.com and write metadata. |
| `pnpm enrich-fab` | Pull the user's FAB library (Epic OAuth) and enrich matches. |
| `pnpm smoke:scan <path>` | Run the walker against a directory without Electron; prints detected folders. |
| `pnpm gen:test-library [outDir]` | Generate an on-disk Unreal test library (default `./test-library`). |

## Development workflow

1. Create a feature branch from `main`.
2. Make your changes.
3. Run `pnpm check` (type-check) and `pnpm lint`.
4. Run `pnpm test:run`.
5. Commit. With the hook enabled (see [Git hooks](#git-hooks)), Biome runs automatically and blocks on unfixable issues.
6. Push and open a PR against `main`.
7. Wait for CI to pass.

For anything larger than a bug fix, open an issue first so the approach can be agreed before you write the code. Keep each PR to one change, describe what it does and how you tested it, and include screenshots for UI changes.

By submitting a pull request you agree that your contribution is licensed under the project's [MIT License](./LICENSE). Everyone taking part is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## CI

CI (`.github/workflows/ci.yml`) is a single Ubuntu job that runs on push and PR to `main`: `pnpm install --frozen-lockfile --ignore-scripts`, then `pnpm lint`, `pnpm check`, and `pnpm test:coverage`. There is no build or packaging matrix in CI; installers are built locally (`pnpm package:mac` on macOS, `pnpm package` on Windows).
