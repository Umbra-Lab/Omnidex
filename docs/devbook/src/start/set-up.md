# Set up a development environment

By the end of this page you will have Omnidex running from source with a working database.

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node | >= 24 (`.nvmrc` pins 24) | Electron 41's toolchain |
| pnpm | 11.1.3 (pinned in `packageManager`) | The lockfile is pnpm's |
| Rust toolchain | rustup, stable | Builds the `.uasset` napi addon |
| Platform compiler | MSVC on Windows, Xcode CLT on macOS | Native modules |

```admonish warning title="pnpm, not npm"
The lockfile and the `packageManager` pin are pnpm's. `npm install` produces a tree the native rebuild step cannot work with.
```

## Install

```bash
pnpm install
```

`postinstall` then does four things in order, and each one matters:

1. **`scripts/ensure-uasset.mjs --soft`** makes sure the `@omnidex/uasset` addon binary (`native/uasset/*.node`) exists. It copies the binary from another worktree of this repo whose addon sources are byte-identical, or builds it with cargo. Without a Rust toolchain it prints a warning and the install continues, but Electron will not launch until the binary exists.
2. **`scripts/ensure-electron.mjs`** downloads and unpacks the Electron binary into `node_modules/electron/dist`. This works around Homebrew-installed pnpm skipping Electron's own postinstall.
3. **`electron-rebuild -f -w better-sqlite3,keytar`** rebuilds those native modules against Electron's ABI rather than system Node's.
4. **`scripts/apply-patches.mjs`** applies `patches/electron-trpc@1.0.0-alpha.0.patch`, which wires superjson into electron-trpc's transformer.

Without step 4, every tRPC call crashes with `Cannot read properties of undefined (reading 'serialize')`.

Once `postinstall` succeeds, `prepare` runs `husky`, which points Git at `.husky/_` so the Biome pre-commit hook runs on every commit.

## The native addon

The `.uasset` parser is a local Rust crate, and its binary is gitignored. `postinstall` provides it, and every command that launches the app (`pnpm dev`, `pnpm preview`, the headless data flags, `pnpm test:electron`) runs `scripts/ensure-uasset.mjs` again first. If the binary is still missing and cannot be built, that command stops with an error instead of starting Electron.

After you edit `native/uasset/src`, rebuild it:

```bash
pnpm build:uasset
```

## Verify

```bash
pnpm check && pnpm lint && pnpm test:run
```

Expect a clean type-check, warnings but no errors from Biome, and:

```
Test Files  42 passed | 3 skipped (45)
     Tests  568 passed | 11 skipped (579)
```

The skipped suites need things CI does not have — a native addon build, or a live model provider.

## Run it

```bash
pnpm dev
```

This starts `electron-vite dev` with hot reload for the renderer. Main-process changes need a restart.

To run the production build instead:

```bash
pnpm build && pnpm preview
```

## If something is wrong

| Symptom | Cause | Fix |
|---|---|---|
| `Could not locate the bindings file` | `pnpm install --force` reset `better-sqlite3` to the system Node ABI | `pnpm run rebuild` |
| Every tRPC call throws `reading 'serialize'` | The superjson patch is not applied | `pnpm apply-patches` |
| Electron binary missing after install | `ensure-electron` did not run | `node scripts/ensure-electron.mjs` |
| `[ensure-electron] ERROR: dist/ still missing`, with only `locales/` unpacked | Node newer than 24; Electron's unzip step breaks under Node 26 | Switch to Node 24 (`.nvmrc`) and reinstall |
| `[ensure-uasset] ERROR: no cargo on PATH` when you launch the app | The addon binary is missing and there is no Rust toolchain | Install rustup, open a new shell, run `pnpm ensure:uasset` |
| `pnpm-workspace.yaml` shows an `allowBuilds:` block in `git status` | pnpm 11.1.3 appends a harmless stub | Delete the appended block; it is not committed |

More in [Troubleshooting](../troubleshooting.md).

## Next steps

- [Index your first library](first-scan.md) — get data into the app
