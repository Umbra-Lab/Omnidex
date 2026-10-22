# Package a release

Installers are built manually on the target platform. There is no build matrix in CI, by design: the native modules cannot be cross-compiled, so a macOS runner cannot produce a Windows installer and vice versa.

| Identity | Value |
|---|---|
| `appId` | `com.umbralab.omnidex` |
| `productName` | `Omnidex` |
| Publish target | GitHub `Umbra-Lab/Omnidex` |

## Before you build

```bash
pnpm check && pnpm lint && pnpm test:run && pnpm build && pnpm test:electron
```

`pnpm test:electron` launches the built app in `out/`, so `pnpm build` comes first.

Bump `version` in `package.json`. It names the artifacts and the `latest*.yml` update manifests. When a user checks for updates, electron-updater compares against the version in the GitHub release, so two artifacts with the same version mean clients never see the second one.

Refresh third-party notices if dependencies changed:

```bash
pnpm notices
```

```bash
pnpm notices:check
```

## Windows

Must run **on Windows** — `scripts/package-win.mjs` hard-fails on any other host.

```bash
pnpm package
```

Target is NSIS x64. Output: `dist-installer/Omnidex-Setup-<version>.exe`.

The script builds the napi addon for `x86_64-pc-windows-msvc`, runs `pnpm build`, then invokes electron-builder.

```admonish warning title="The addon filename is checked"
`native/uasset/index.js` requires `omnidex-uasset.win32-x64-msvc.node` by exact name, and the packaging script verifies it exists. If you rename a target triple, change both or packaging fails late with a confusing missing-module error at runtime.
```

arm64 Windows is deferred.

## macOS

```bash
pnpm package:mac
```

Builds the addon for `aarch64-apple-darwin`, runs `pnpm build`, then `electron-builder --mac --arm64`. Output: `dist-installer/Omnidex-<version>-arm64.dmg` and `.zip`.

The script accepts `--universal` for an Intel-inclusive build, but the shipped target is arm64.

## Publishing

```bash
pnpm release
```

```bash
pnpm release:mac
```

These add `--publish` to the same pipeline, uploading to GitHub Releases, which is where electron-updater looks.

Installed copies read the manifest from that release only when the user pressed **Check for updates** or turned on **Check automatically**. What a release needs before an update installs in place, mainly a signed and notarized macOS build, is on [Software updates](../subsystems/updates.md).

## Known traps

```admonish danger title="pnpm rebuild is not pnpm run rebuild"
`pnpm rebuild` is pnpm's own built-in command and rebuilds everything. `pnpm run rebuild` runs this repo's script, which rebuilds only `better-sqlite3` and `keytar` against Electron's ABI.

The repo's `package.json` defines `rebuild`, so `pnpm rebuild` resolves to the built-in and silently does something different. Use `pnpm run rebuild` when you mean the script.
```

**winCodeSign symlinks.** electron-builder's `winCodeSign` package contains symlinks that fail to extract without Developer Mode or elevation on Windows. The failure appears as a cache-extraction error unrelated to your build.

**electron-updater is CommonJS.** A named ESM import of `electron-updater` resolves to `undefined` at runtime and the error surfaces far from the import. Use the default import.

## Verify the artifact

Install it and check:

1. The app opens its own `userData` directory, not a dev one.
2. Scanning works — this exercises the packaged native addon, which is the most common packaging casualty.
3. Thumbnail extraction produces images. The extractor runs in a child process that resolves the addon by absolute path; if the packaged layout puts it inside an asar the child cannot read, every thumbnail fails silently rather than crashing.

```admonish warning title="app.setName must be pinned"
Without `app.setName('omnidex')` before `app.whenReady()`, packaged and dev launches resolve different `userData` directories and different databases. The symptom is a packaged build that appears to have lost the library.
```

## Next steps

- [Testing](../standards/testing.md) — what to run before tagging
- [Paths and files](../reference/paths.md) — where a packaged install writes
