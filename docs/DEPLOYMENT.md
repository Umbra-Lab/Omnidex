# Omnidex deployment guide

Build, package, and ship Omnidex installers. The stack is Electron 41 + React 19 + better-sqlite3, with a Rust napi-rs addon (`@omnidex/uasset`) compiled from `native/uasset/`. Installers are produced manually on the target OS — there is no CI build matrix. Distribution is via GitHub Releases on `Umbra-Lab/Omnidex`, and the app can check GitHub Releases for updates with `electron-updater`. The check is opt-in and off by default (see [Auto-update](#auto-update)).

The current version is `2.0.7` (`package.json` `"version"`). electron-builder reads the version from `package.json`.

---

## Prerequisites

- **Node 24** (`.nvmrc` pins `24`; `engines.node` requires `>=24`).
- **pnpm 11.1.3** — pinned via `"packageManager": "pnpm@11.1.3"` in `package.json`. Use Corepack (`corepack enable`) or install that exact version.
- **Rust toolchain** (`rustup`) — only to compile the `@omnidex/uasset` napi addon. `rustup` installs the host target automatically.
- **Platform toolchain** for the OS you are building on: Xcode Command Line Tools on macOS (`xcode-select --install`), MSVC build tools on Windows.
- **A `GH_TOKEN`** with `repo` scope on `Umbra-Lab/Omnidex` — only for `pnpm release` / `pnpm release:mac`, not for local-only builds.

`pnpm install` runs `postinstall`, which copies or builds the `@omnidex/uasset` addon binary (`scripts/ensure-uasset.mjs`), downloads the Electron binary (`scripts/ensure-electron.mjs`), rebuilds `better-sqlite3` and `keytar` against Electron's ABI (`electron-rebuild`), and applies the electron-trpc superjson patch (`scripts/apply-patches.mjs`). No manual steps are required after a clean clone.

---

## Local install + smoke test

```bash
pnpm install            # downloads Electron, rebuilds native modules, applies patches
pnpm dev                # electron-vite dev, hot-reload loop
```

`pnpm dev` runs `node scripts/run-electron.mjs electron-vite dev`. There is a single React renderer; there is no alternate frontend to select.

To populate the local DB before browsing, run the CLI data jobs (these run headlessly and exit). The same services also run from the app, through the scan and enrich buttons in Settings and the Command Palette:

```bash
pnpm refresh-scans      # scan active filesystem locations into the DB
pnpm extract-thumbs     # extract missing thumbnails from .uasset via the napi addon
pnpm enrich-orbital     # match assets against orbital-market.com
pnpm enrich-fab         # pull the FAB library (Epic OAuth) and enrich matches
```

---

## Building for macOS (arm64)

macOS builds run **on a Mac** — `hdiutil`, `codesign`, and the darwin-ABI native modules don't exist elsewhere. The shipped target is **Apple Silicon (arm64) only**.

```bash
pnpm package:mac        # unsigned, runs locally
pnpm release:mac        # signed + notarized + uploaded (needs Apple creds + GH_TOKEN)
```

`pnpm package:mac` runs `scripts/package-mac.mjs`, which renders the icon set, builds the `@omnidex/uasset` addon for the host arch and syncs the `.node` into `node_modules/@omnidex/uasset`, runs `pnpm build`, then `electron-builder --mac --arm64`. Local builds set `CSC_IDENTITY_AUTO_DISCOVERY=false` so the unsigned `.dmg` always completes; `--publish` switches to the signed path and uploads to the GitHub release.

**Outputs** (in `dist-installer/`):

- `Omnidex-<version>-arm64.dmg` — the installer.
- `Omnidex-<version>-arm64.zip` + `Omnidex-<version>-arm64.zip.blockmap` — the auto-update feed payload.
- `latest-mac.yml` — auto-update manifest electron-updater reads from the latest GitHub Release.
- `mac-arm64/Omnidex.app` — the unpacked app for inspection. The bundled `THIRD-PARTY-NOTICES.md` and `LICENSE` land in `Omnidex.app/Contents/Resources/` (see [Third-party license notices](#third-party-license-notices)).

Intel and universal builds are deferred. `scripts/package-mac.mjs` accepts a `--universal` flag that adds the `x86_64-apple-darwin` Rust target and builds a dual-arch `.dmg`, but the default and shipped artifact is host-arch arm64.

Full prerequisites, the unsigned-launch Gatekeeper workaround, signing/notarization env vars, and the macOS-specific code changes are in **[docs/MACOS-BUILD.md](MACOS-BUILD.md)**.

---

## Building for Windows (x64)

Windows builds run **on a Windows host**. `scripts/package-win.mjs` has a hard `process.platform !== 'win32'` guard and errors out on macOS/Linux: the native modules (`@omnidex/uasset`, `better-sqlite3`, `keytar`) need MSVC and cannot be cross-compiled.

```powershell
pnpm package            # build + electron-builder, no upload
pnpm release            # signed + uploaded (needs GH_TOKEN)
```

`pnpm package` runs `scripts/package-win.mjs`, which builds the addon for `x86_64-pc-windows-msvc`, fails fast if `omnidex-uasset.win32-x64-msvc.node` is missing, re-runs `electron-rebuild`, then `electron-builder --win --x64`. The target is NSIS x64; arm64 Windows is deferred.

**Outputs** (in `dist-installer/`):

- `Omnidex-Setup-<version>.exe` — NSIS installer.
- `Omnidex-Setup-<version>.exe.blockmap` — used by electron-updater for differential downloads.
- `latest.yml` — auto-update manifest.
- `win-unpacked/` — uncompressed app tree, for inspection. The bundled `THIRD-PARTY-NOTICES.md` and `LICENSE` land in `win-unpacked\resources\` (see [Third-party license notices](#third-party-license-notices)).

The installer is per-user and silent (`oneClick: true`, `perMachine: false`): it installs to `%LOCALAPPDATA%\Programs\Omnidex\` with no UAC prompt and launches on completion.

---

## Auto-update

Update checks are **opt-in and off by default**. The design, the state machine, and what has to exist before updates can be delivered for real are in [`docs/devbook/src/subsystems/updates.md`](docs/devbook/src/subsystems/updates.md).

`electron-updater` is wired in `electron/main/updater.ts` and started from `app.whenReady()` in `electron/main/index.ts`. It only runs in packaged builds (`app.isPackaged`); dev builds skip it.

A check runs only when the user presses **Check for updates** (Settings → About, or the application menu), or, if they turned on **Check automatically**, at launch and every 4 hours. Each check:

1. Fetches the release feed and the update manifest (`latest.yml` / `latest-mac.yml`) from the latest published GitHub Release.
2. Compares the published version to the running version.
3. If newer, offers **Download update** and **View release** in a banner and in Settings → About. Nothing downloads until the user chooses. A Windows download fetches changed bytes only, via `.blockmap`.
4. After a download, offers **Restart now** or **Later**. Restart now applies the update and relaunches; Later installs on next quit (`autoInstallOnAppQuit`).

An update installs in place only from a signed build. On macOS `electron-updater` can only apply an update signed with a Developer ID, so an unsigned or ad-hoc build finds the update, fails the download, and offers **View release** instead. See [Code signing](#code-signing).

While `Umbra-Lab/Omnidex` has zero published releases, GitHub returns 404 for `releases.atom`. The updater treats that as "no releases published yet" and shows it in Settings → About instead of an error.

---

## Releasing a new version

```powershell
# 1. Bump the version in package.json:  "version": "2.0.8"

# 2. Build + upload to GitHub Releases
$env:GH_TOKEN = "ghp_..."     # token with repo scope on Umbra-Lab/Omnidex
pnpm release                  # on Windows, for the NSIS installer
# pnpm release:mac            # on a Mac, for the arm64 dmg/zip

# 3. Publish the release on github.com/Umbra-Lab/Omnidex/releases.
#    Installed copies with automatic checks turned on find it within 4 hours;
#    everyone else finds it when they press Check for updates.
```

`pnpm release` and `pnpm release:mac` pass `--publish always` to electron-builder, which uploads the installer, `.blockmap`, and the manifest (`latest.yml` / `latest-mac.yml`) to a release tagged `v<version>`. Because macOS and Windows are built on separate hosts, run each release command on its own OS to publish both platforms for a version.

---

## Code signing

**macOS** — signing and notarization are wired and run when the `APPLE_*` and `CSC_*` env vars are present during `pnpm release:mac`. `build.mac` enables `hardenedRuntime` with `build/entitlements.mac.plist`, and electron-builder invokes `@electron/notarize` automatically. See [docs/MACOS-BUILD.md](MACOS-BUILD.md) for the full env list. Unsigned local builds (`pnpm package:mac`) are Gatekeeper-quarantined on first launch; clear with `xattr -dr com.apple.quarantine` or right-click → Open.

**Windows** — installers are currently unsigned, so SmartScreen warns first-time users. To sign, set `WIN_CSC_LINK` (path or URL to a `.pfx`) and `WIN_CSC_KEY_PASSWORD` before `pnpm release`. EV certs skip SmartScreen; OV/IV certs build reputation over time.

---

## Troubleshooting

**`Cannot find module '@omnidex/uasset'` / app quits on launch**
The napi addon wasn't built or synced into `node_modules/@omnidex/uasset`. pnpm's `file:` copy happens at install time, before the addon is built. Run `pnpm build:uasset`, then re-run the packaging script (`package:mac` / `package` does this for you).

**`Could not locate the bindings file` for `better-sqlite3`**
`postinstall` runs `electron-rebuild` against Electron's ABI on every `pnpm install`. If a stray Node-ABI build leaks in, run `pnpm run rebuild`. Note: `pnpm rebuild` (no `run`) calls pnpm's built-in rebuild, which targets the system-Node ABI and is wrong here.

**`Named export 'autoUpdater' not found`**
`electron-updater` is CommonJS and the main bundle is ESM. Use a default import, as in `electron/main/updater.ts`:
`import electronUpdater from 'electron-updater'; electronUpdater.autoUpdater.checkForUpdates();`
Read `autoUpdater` inside a function, not at module scope. It is a getter that loads the real `electron` module, which unit tests do not have.

**`Cannot create symbolic link ... darwin/10.12/lib/libcrypto.dylib`** (Windows)
electron-builder's `winCodeSign` archive contains macOS dylib symlinks that 7-Zip can't extract without admin or Developer Mode. Pre-extract the cache at `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\` once, excluding the darwin dylibs; it survives rebuilds.

**`The process cannot access the file ... app.asar`** (Windows)
A workspace indexer holds a handle on `dist-installer\win-unpacked\resources\app.asar` from a prior build. Build to a fresh output dir: `pnpm exec electron-builder --win --publish never --config.directories.output=dist-installer-v2`. The lock releases on session end.

---

## Third-party license notices

The packaged app bundles JetBrains Mono (SIL OFL 1.1), Archivo (self-hosted `.ttf` files in `renderer-react/src/assets/fonts/`, SIL OFL 1.1; sources and notices in `font-licenses.json`), and its production npm dependencies. The OFL/MIT/BSD/Apache licenses all require their copyright and permission notices to ship with the binary, and the `build.files` block strips `LICENSE`/`*.md` out of `node_modules`. To stay compliant, `scripts/gen-third-party-notices.mjs` aggregates every notice into `THIRD-PARTY-NOTICES.md`.

```bash
pnpm notices            # regenerate THIRD-PARTY-NOTICES.md
pnpm notices:check      # exits non-zero if it is stale (use in CI / pre-release)
```

The script is dependency-free: it walks the production dependency tree from the root `package.json` `dependencies` (following pnpm's symlinks via realpath), reads each resolved package's declared license id and bundled license text, and adds explicit OFL attributions for the fonts listed in `BUNDLED_FONTS`, currently Inter and JetBrains Mono. That list does not cover Founders Grotesk, which has its own license, and it still names Inter, which the renderer no longer imports. Because it only follows what is physically present in `node_modules`, it captures exactly the host-platform native binaries that ship (e.g. `@img/sharp-darwin-arm64` and the LGPL `@img/sharp-libvips-darwin-arm64`) and skips the foreign-platform optional binaries that do not.

`scripts/package-mac.mjs` and `scripts/package-win.mjs` regenerate the file as step 0 of every packaging run, so it never drifts from the dependency tree. electron-builder ships it (and the root `LICENSE`) via `build.extraResources`, which lands them in the app's `Resources/` directory — `Omnidex.app/Contents/Resources/THIRD-PARTY-NOTICES.md` on macOS and `resources\THIRD-PARTY-NOTICES.md` next to `app.asar` on Windows.

---

## Versioning

Follow SemVer. Bump only `package.json` `"version"` — electron-builder, the artifact names, and the auto-update manifests all derive from it.

- **MAJOR** — breaking schema migrations, removed features.
- **MINOR** — new features, backward-compatible.
- **PATCH** — bug fixes only.
