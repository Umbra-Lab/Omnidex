# Privacy & data disclosure

_Last updated: 2026-09-29_

Omnidex is a **local-first desktop application**. It indexes the Unreal
Engine / FAB asset packs already on your computer and stores everything it
learns about them in a local database on your machine. This document explains,
in plain language, exactly what data leaves your computer, what does not, and
which third-party services are involved.

This is an honest description of how the app **currently behaves** — not a
description of a future or ideal state. If you find a discrepancy between this
document and the code, the code is the source of truth and this document is the
bug; please open an issue.

## Summary

- Omnidex stores its index — asset names, paths, extracted thumbnails, and any
  fetched metadata — in a local [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
  database inside your user-data directory. **Nothing is uploaded to an Omnidex
  server. There is no Omnidex server.**
- To enrich your assets with titles, descriptions, sellers, thumbnails,
  ratings, categories, and supported engine versions, Omnidex contacts **two
  external sources**: `orbital-market.com` (a community catalog) and
  **Epic / FAB** (for the library you personally own, via your own Epic login).
- The data that leaves your machine during enrichment is **asset names**
  (used as search queries) and, for the FAB step only, **your Epic OAuth
  credentials and account id** (used to fetch *your own* owned library).
- Update checks are **off by default**. Omnidex contacts GitHub (`github.com`)
  for a newer release only when you press **Check for updates**, or if you turn
  on **Check automatically** in Settings → About. A packaged build makes no
  update request at launch unless you did — see
  [Software updates](#3-software-updates-opt-in-off-by-default) below.
- Omnidex contains **no telemetry, analytics, crash reporting, or usage
  tracking** of any kind. We do not collect, transmit, or sell information
  about you or how you use the app, and there is no Omnidex-operated server.

## What data leaves your machine

### 1. Asset names → orbital-market.com

When you run marketplace enrichment, Omnidex takes the name of each local asset
pack (cleaned up — punctuation and trailing version numbers stripped), and
sends it as a **search query** to `orbital-market.com`:

- `POST https://orbital-market.com/api/products/search` with the cleaned asset
  name as the search text.
- `GET https://orbital-market.com/api/products/...` to fetch the matched
  product's detail (title, description, seller, price, rating, categories,
  supported engine versions, gallery image URLs).

Only the **name** is sent. Your file paths, your folder structure, your
machine identifiers, and the contents of the asset files are **not** sent to
orbital-market.

**About orbital-market.com.** orbital-market.com (the "Orbital Market" project)
is an **independent, community-run catalog mirror of the Unreal Engine / FAB
marketplace**. It is **not affiliated with, endorsed by, or operated by Epic
Games or FAB.** It is a third-party source: it may be slow, rate-limited, or
**completely unavailable** at any time, and Omnidex is built to back off
politely and degrade gracefully when that happens (low concurrency, request
spacing, `Retry-After` handling, and a circuit breaker that stops sending
requests after repeated failures). If orbital-market is unreachable, enrichment
simply produces fewer matches; nothing else breaks.

orbital-market is provided by its authors under "all rights reserved" terms and
exposes no officially sanctioned third-party API. Omnidex consumes it on a
best-effort, polite-client basis and may have to change or remove this source
in the future.

### 2. Your owned library → Epic / FAB (only if you connect your Epic account)

If you choose to enrich against the assets you **own** on FAB, Omnidex uses
**your own Epic Games login** to fetch **your own** library. This step only
runs when you have provided Epic credentials.

- OAuth token exchange / refresh with
  `https://account-public-service-prod.ol.epicgames.com` (and the Epic redirect
  endpoint at `https://www.epicgames.com/id/api/redirect` during the one-time
  authorization-code step).
- Your owned library is fetched from
  `https://www.fab.com/e/accounts/<your-account-id>/ue/library` using your
  bearer token.

What leaves your machine here is your **Epic access/refresh token and your Epic
account id** — sent to Epic's own servers, to retrieve **your own** owned
library. Omnidex does not send your Epic credentials anywhere except Epic, and
does not send them to orbital-market or to any Omnidex-controlled service
(again: there is no Omnidex server).

Your Epic credentials are stored locally on your machine (an
`epic_credentials.json` file in your user-data directory). Treat that file like
any other secret. **Omnidex is not affiliated with or endorsed by Epic Games or
FAB.**

### 3. Software updates (opt-in, off by default)

Omnidex can check GitHub for a newer release. It checks only when you ask:

- **Check for updates** (Settings → About, or the application menu) makes one
  check each time you press it.
- **Check automatically** (Settings → About) is **off by default**. Turn it on
  and Omnidex checks straight away, then at launch and every 4 hours while it
  runs. Turn it off and the schedule stops. The choice is stored locally in the
  app database (`updates.auto_check`), not sent anywhere.

Only an installed build checks. A development build never does.

**What a check requests.** All three requests go to `github.com`, for the
`Umbra-Lab/Omnidex` repository:

- `GET https://github.com/Umbra-Lab/Omnidex/releases.atom` — the public release
  list.
- `GET https://github.com/Umbra-Lab/Omnidex/releases/latest` — resolves the
  latest release tag.
- `GET https://github.com/Umbra-Lab/Omnidex/releases/download/<tag>/latest.yml`
  (Windows) or `latest-mac.yml` (macOS) — the update manifest: version, file
  names, and checksums.

**What is sent.** Each is an ordinary HTTPS request: your IP address and the
standard headers Electron adds, including a user-agent string that names
Omnidex, its version, your operating system, and the Electron and Chromium
versions. Nothing about your library, asset names, file paths, or scan folders
is sent, and Omnidex adds no identifier of its own. GitHub handles those
requests under its own privacy statement.

**Downloading.** A check never downloads an installer. Only pressing **Download
update** does. It requests the installer from
`https://github.com/Umbra-Lab/Omnidex/releases/download/<tag>/` (plus the
`.blockmap` files that let a Windows update fetch only what changed). GitHub
redirects those downloads to its release-asset storage, hosts under
`githubusercontent.com`. The request carries the same information as a check.

**Installing.** When a download finishes you choose **Restart now** or
**Later**. Later installs the update the next time you quit Omnidex.

**What installing needs.** On macOS, `electron-updater` can only apply an update
whose signature chains to an Apple Developer ID, and Omnidex's macOS builds are
not signed that way today. There a check can find an update, but the download
fails and Omnidex points you to the release page to install by hand. Windows
installers are unsigned today, so Windows may show a SmartScreen warning when
you run one. This section will not claim in-place updates work until signed
releases exist.

## What does NOT leave your machine

- **No telemetry. No analytics. No crash/error reporting to us.** Omnidex
  bundles no Sentry, Segment, Mixpanel, Amplitude, PostHog, Google Analytics,
  or comparable SDK. Crash diagnostics (minidumps) and logs are written **only
  to local files** on your machine and are never uploaded. Automatic update
  checks are off by default (see above), so unless you turn on **Check
  automatically** Omnidex makes **no** automatic network call on its own — the
  enrichment requests run only when you start them, and an update check runs
  only when you press the button.
- **No personal profiling.** Omnidex does not build or transmit a profile of
  you, your hardware, or your usage patterns.
- **No file contents.** The bytes of your `.uasset`/`.umap` files are read
  locally to extract thumbnails and metadata; the files themselves are never
  uploaded.
- **No file paths or folder structure** are sent to orbital-market — only the
  asset name string used as a search query.
- **No advertising identifiers, no third-party trackers.**

## Where your data is stored

Everything Omnidex indexes lives **locally** in your operating system's
user-data directory for the app:

- the SQLite index database,
- extracted thumbnail images,
- your Epic credentials file (if you connected an Epic account).

Deleting the app's user-data directory removes this local data. Nothing about
it is retained on any server operated by the Omnidex project, because no such
server exists.

## A note on current behavior

Enrichment is **on**: when you run the enrichment jobs, the network requests
described above are made. **There is not yet an in-app toggle to disable
enrichment or to choose individual sources.** A granular opt-out is on the
roadmap, but to be accurate to how the app works today: if you do not want a
given source contacted, do not run that enrichment job. (The FAB step never
runs unless you have connected your Epic account; the orbital-market step runs
whenever you run marketplace enrichment.)

## Third-party services & their terms

- **orbital-market.com** — community catalog mirror, unaffiliated with
  Epic/FAB. See <https://orbital-market.com>.
- **Epic Games / FAB** — your owned library, accessed with your own Epic login.
  See Epic's and FAB's terms at <https://www.fab.com/legal> and
  <https://legal.epicgames.com>.

## Changes to this disclosure

We will update this document when the app's data behavior changes. The "Last
updated" date at the top reflects the most recent revision. Material changes
will also be noted in the changelog.

## Contact

Questions about this disclosure can be raised as an issue on the Omnidex
repository.
