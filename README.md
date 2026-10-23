# Omnidex

**Find any asset you own.** Omnidex indexes the Unreal Engine and Fab asset packs on your drives, and the video courses beside them, into one searchable local library. Free, open source, Windows and macOS.

[Download](https://github.com/Umbra-Lab/Omnidex/releases) · [Developer handbook](docs/devbook/src/SUMMARY.md) · [Contributing](CONTRIBUTING.md) · [Sponsor](https://github.com/sponsors/figgiee)

## What it does

- **Scans your folders** for `.uasset`/`.umap` packs and course folders, and keeps the index current as you rescan.
- **Shows real thumbnails** extracted straight from the `.uasset` files, with no Unreal Editor running.
- **Fills in metadata** (category, seller, description, images) by matching packs against Orbital Market and your own Fab library.
- **Searches everything** with full-text search, filters and sorting across thousands of packs.
- **Organizes** packs into collections, and the health page lists every folder a scan skipped, with the reason and the fix.
- **Plays your courses** with resume, notes, and searchable transcripts from subtitle files.
- **Answers questions** about your library and courses through a local model server you run, or the Claude CLI.

Everything stays on your machine. There is no telemetry and no account. [`PRIVACY.md`](PRIVACY.md) lists exactly what the optional enrichment sends and where.

## Install

Download the installer for your platform from the [Releases page](https://github.com/Umbra-Lab/Omnidex/releases):

| Platform | File |
|---|---|
| Windows 10/11 (x64) | `Omnidex-Setup-<version>.exe` |
| macOS (Apple silicon) | `Omnidex-<version>-arm64.dmg` |

The builds are not code-signed yet. On Windows, choose **More info → Run anyway** at the SmartScreen prompt. On macOS, right-click the app and choose **Open** the first time.

Open Omnidex, add the folder that holds your asset packs, and the first scan starts. Add more folders under **Settings → Folders**.

## Build from source

You need Node 24 (`.nvmrc`), pnpm 11, and Rust 1.88 or newer. On macOS, also the Xcode Command Line Tools; on Windows, the MSVC build tools.

```bash
git clone https://github.com/Umbra-Lab/Omnidex.git
cd Omnidex
pnpm install
pnpm dev
```

`pnpm install` builds the Rust addon, downloads Electron and applies the bundled patches, so no other setup is needed. To build an installer, run `pnpm package` on Windows or `pnpm package:mac` on macOS; output lands in `dist-installer/`. The [set-up guide](docs/devbook/src/start/set-up.md) and [troubleshooting page](docs/devbook/src/troubleshooting.md) cover everything else.

## Work on it with an AI agent

The repository is set up for coding agents. [`AGENTS.md`](AGENTS.md) holds the commands, the definition of done, and the rules that are not obvious from the code. Claude Code, Codex, Cursor, Copilot and Gemini CLI all pick it up automatically.

A good first prompt:

> Read AGENTS.md, then fix issue #N. Run the checks it lists and show me the output before you open a pull request.

Agent-written pull requests are welcome when a person has reviewed them, can explain every change, and discloses the tool used. See the [AI-assisted contributions policy](CONTRIBUTING.md#ai-assisted-contributions).

## How it fits together

An Electron main process owns the SQLite database, the file scanner and every network call. The React renderer reads from it over tRPC. A Rust addon parses `.uasset` headers and extracts thumbnails in disposable worker processes, so a malformed file cannot crash the app. The [architecture page](docs/devbook/src/orientation/architecture.md) has the full picture.

## Third-party services

Omnidex is an unofficial community tool. It is not affiliated with, endorsed by, or supported by Epic Games, Fab, Unreal Engine or Orbital Market. Fab library sync signs in to your own Epic account and reads only your own library. Orbital enrichment reads public product listings at a throttled rate. Neither service offers a public API, so either feature can stop working without notice.

## Support the project

Omnidex is built and maintained in spare time. If it saves you time, [sponsoring on GitHub](https://github.com/sponsors/figgiee) keeps it going. Bug reports and ideas go in [Issues](https://github.com/Umbra-Lab/Omnidex/issues). Report security problems privately as described in [`SECURITY.md`](SECURITY.md).

## License

MIT, see [`LICENSE`](LICENSE). Bundled fonts (Archivo, JetBrains Mono) are under the SIL Open Font License, and every bundled dependency's license is collected in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Unreal Engine and Fab are trademarks of Epic Games, Inc.
