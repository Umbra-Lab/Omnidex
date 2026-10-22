# Omnidex macOS build guide

This guide covers the macOS build, which produces an arm64 `.dmg` (+ `.zip` for
auto-update) from the Electron 41 + React codebase. Everything below runs **on a
Mac** — `hdiutil`, `codesign`, and the darwin-ABI native modules don't exist on
Linux/Windows, so the `.dmg` can only be produced on macOS (or a macOS CI
runner). The Windows installer is built separately on Windows (`pnpm package`).

> The cross-platform application logic (DB + migrations, the Rust `@omnidex/uasset`
> napi addon, Orbital enrichment, the React renderer) runs headlessly via the CLI
> data-op scripts; the macOS-specific delta is packaging + window chrome + the
> Epic VaultCache path, all wired below.

---

## Prerequisites (on the Mac)

- **macOS 12+** (Monterey or newer), Apple Silicon. The shipped build is
  **arm64-only** (see below); an Intel Mac would build an x64 dmg but that target
  is not currently produced.
- **Node.js 24** (`.nvmrc` = `24`, `engines.node` `>=24`). Node 24's stable
  `node:sqlite` is what the unit suite uses.
- **pnpm 11.1.3** — pinned in `package.json` via `"packageManager": "pnpm@11.1.3"`.
- **Rust toolchain** (`rustup`) — the `@omnidex/uasset` napi addon is compiled
  from source. `rustup` installs the host target automatically; the addon pins
  `rust-version = "1.88"`.
- **Xcode Command Line Tools** (`xcode-select --install`) — for `codesign`,
  `hdiutil`, and native-module compilation.

```bash
pnpm install
```

`pnpm install` is reproducible with no manual follow-up steps. Its `postinstall`
runs three things in order:

1. `scripts/ensure-electron.mjs` — downloads and unpacks the Electron binary
   (works around pnpm 11.1.3 skipping Electron's own postinstall).
2. `electron-rebuild -f -w better-sqlite3,keytar` — rebuilds those two native
   modules against Electron's ABI.
3. `scripts/apply-patches.mjs` — idempotently applies the electron-trpc patch
   that wires superjson into the IPC transformer. Without it every tRPC call
   crashes; the script is safe to re-run.

> pnpm 11.1.3 may append a harmless `allowBuilds:` stub to the bottom of
> `pnpm-workspace.yaml` on install. It is not committed — delete the appended
> block if it shows up in `git status`.

---

## Build the app (unsigned, runs locally)

```bash
pnpm package:mac
```

This runs `scripts/package-mac.mjs`, which:

1. Renders the icon set, including `build/icon.icns`.
2. Builds the `@omnidex/uasset` napi addon **for the host arch**
   (`aarch64-apple-darwin`) and syncs the `.node` into the resolved dependency
   dir. On this repo `node_modules/@omnidex/uasset` is a symlink back to
   `native/uasset`, so the sync is a no-op self-copy and is skipped; the loop
   only does real work if a future install layout makes the dependency a
   separate directory.
3. Builds the renderer + main + preload bundles (`pnpm run build`).
4. Runs `electron-builder --mac --arm64 --publish never` with code signing
   **disabled** (`CSC_IDENTITY_AUTO_DISCOVERY=false`) so the build always
   completes.

**Output** (in `dist-installer/`):

- `Omnidex-<version>-arm64.dmg` — the installer (e.g. `Omnidex-2.0.7-arm64.dmg`).
- `Omnidex-<version>-arm64.zip` + `latest-mac.yml` — auto-update feed.
- `mac-arm64/Omnidex.app` — the unpacked app for inspection.

### Running an unsigned build

The unsigned/ad-hoc app is Gatekeeper-quarantined on first launch. Either:

- Right-click `Omnidex.app` → **Open** → **Open** (one-time), or
- `xattr -dr com.apple.quarantine /Applications/Omnidex.app`

### Universal (Intel + Apple Silicon) build — not currently produced

The script supports a `--universal` flag that builds both darwin `.node` arches
and a dual-arch `.dmg`:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
node scripts/package-mac.mjs --universal
```

This path is **not part of the shipped build** — `build.mac` targets `arm64`
only, and Intel/universal is deferred. The flag is kept for when a universal
artifact is needed; napi's `index.js` selects the right binary at runtime by
`process.arch`.

---

## Signed + notarized release

For distribution outside your own machine, sign with a Developer ID and notarize
(otherwise Gatekeeper hard-blocks the app on other Macs). Set the env, then:

```bash
export CSC_LINK=/path/to/DeveloperID.p12        # or keychain identity
export CSC_KEY_PASSWORD=…
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=abcd-efgh-ijkl-mnop
export APPLE_TEAM_ID=XXXXXXXXXX
pnpm release:mac        # signs, notarizes, uploads to the GitHub release
```

`pnpm release:mac` is `scripts/package-mac.mjs --publish`, which switches
electron-builder to `--publish always` and the signed path. `build.mac` already
enables `hardenedRuntime` and points at `build/entitlements.mac.plist`, which
grants the hardened-runtime exceptions Electron and the unsigned native addons
need: JIT + unsigned-executable-memory + dyld-environment-variables,
`disable-library-validation` (for the ad-hoc better-sqlite3 / keytar /
`@omnidex/uasset` binaries), and `network.client` (Orbital enrichment, FAB sync,
auto-updater). electron-builder runs `@electron/notarize` automatically when the
`APPLE_*` vars are present.

The publish target is the GitHub repo `Umbra-Lab/Omnidex` (appId
`com.umbralab.omnidex`).

---

## What the macOS build changes

| Area | Change |
|------|--------|
| `build.mac` / `build.dmg` (`package.json`) | arm64 dmg + zip targets, `build/icon.icns`, `public.app-category.developer-tools`, hardened runtime, entitlements, artifact name `Omnidex-${version}-${arch}.${ext}` |
| `scripts/build-icon.mjs` | also emits `build/icon.icns` |
| `build/entitlements.mac.plist` | hardened-runtime exceptions for Electron + native addons |
| `scripts/package-mac.mjs` | host-arch addon build + sync, then `electron-builder --mac --arm64` |
| `electron/main/index.ts` | `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: { x: 13, y: 10 }` on darwin, so the native traffic lights sit inside the React title bar |
| `electron/main/fab/watcher.ts` | macOS Epic VaultCache default: `~/Library/Application Support/Epic/EpicGamesLauncher/VaultCache` |

`app.getPath('userData')` resolves to `~/Library/Application Support/omnidex/`
on macOS — the DB, thumbnails, and credentials land there with no code change.
keytar uses the macOS Keychain (no `libsecret`). The global hotkey
`CommandOrControl+Shift+O` (`electron/main/native/hotkeys.ts`) maps to ⌘⇧O.

---

## Troubleshooting

**`Cannot find module '@omnidex/uasset'` / app quits on launch**
The addon wasn't built/synced. Run `pnpm build:uasset` then re-run
`pnpm package:mac` (the packaging script does this for you).

**`electron-builder` can't find a signing identity**
Expected for `pnpm package:mac` — it disables signing on purpose. Use
`pnpm release:mac` with the `CSC_*`/`APPLE_*` env for a signed build.

**App is "damaged and can't be opened"**
Gatekeeper on an unsigned build. `xattr -dr com.apple.quarantine` the `.app`.

**Wrong-arch crash on launch (`mach-o, but wrong architecture`)**
The packaged `.node` doesn't match the dmg arch. `pnpm package:mac` builds for
the host arch (arm64) only; the shipped dmg is arm64.
