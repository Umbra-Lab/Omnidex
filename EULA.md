# End-user terms (EULA)

_Last updated: 2026-06-14_

These plain-language end-user terms describe what you can expect when you use
**Omnidex**. Omnidex is free, open-source software distributed under the
[MIT License](./LICENSE); these terms summarize the practical points and the
software's relationship to third-party services. Where this summary and the
MIT License differ on legal effect, the **MIT License governs**.

## 1. What Omnidex is

Omnidex is a **local desktop application** that indexes and browses the Unreal
Engine / FAB asset packs already stored on your computer. It scans your folders,
extracts thumbnails, and enriches each pack with metadata so you can search,
filter, and organize your collection. It is a **personal indexing tool**, not a
storefront, a download client, or a redistribution service. It does not sell,
host, or deliver any marketplace asset to you.

## 2. License

Omnidex is provided under the **MIT License** (see [`LICENSE`](./LICENSE)). You
may use, copy, modify, and distribute it under those terms. As stated there, the
software is provided **"as is", without warranty of any kind**, and the authors
are **not liable** for any claim or damages arising from its use.

## 3. Data & privacy

Omnidex is local-first and contains **no telemetry or analytics**. To enrich
your assets it contacts third-party sources and, for your owned library, uses
**your own** Epic login. Exactly what data leaves your machine, what does not,
and which services are contacted is described in detail in
[`PRIVACY.md`](./PRIVACY.md). **By using the enrichment features you acknowledge
the data flows described there.** Please read it.

In short:

- Asset **names** are sent to `orbital-market.com` as search queries.
- If you connect an Epic account, your **own** Epic credentials are used to
  fetch your **own** owned FAB library from Epic's servers.
- Automatic update checking is **currently disabled** (gated off until signed
  releases exist), so packaged builds contact no update server; see
  [`PRIVACY.md`](./PRIVACY.md) for details.
- No telemetry, analytics, crash reporting, file contents, or file paths are
  transmitted to the Omnidex project, and there is **no Omnidex-operated
  server**. The only services Omnidex contacts are the third parties named
  here (orbital-market.com and, if you connect an account, Epic/FAB).

## 4. Third-party services — not affiliated, not guaranteed

Omnidex is an **independent project**. It is **not affiliated with, endorsed by,
sponsored by, or operated by Epic Games, FAB, or the Orbital Market project.**
"Unreal Engine", "FAB", and "Epic Games" are trademarks of their respective
owners and are used here only descriptively.

Metadata enrichment depends on third-party services that Omnidex does not
control:

- **orbital-market.com** is a community catalog mirror provided by its authors
  under "all rights reserved" terms, with no officially sanctioned third-party
  API. It may be rate-limited, changed, or **unavailable** at any time. Omnidex
  accesses it as a polite, best-effort client and **may have to change or remove
  this source** in the future. When it is unavailable, enrichment simply yields
  fewer matches.
- **Epic / FAB** access uses **your own** account credentials and is subject to
  **Epic's and FAB's own terms of service**. You are responsible for using your
  own account in accordance with those terms. See <https://www.fab.com/legal>
  and <https://legal.epicgames.com>.
- **GitHub** hosts Omnidex's source and (in the future) signed release downloads.
  Automatic update checking is currently disabled, so packaged builds do not
  contact GitHub at runtime; this will change when signed releases are introduced.

Omnidex makes **no guarantee** of the accuracy, completeness, availability, or
continued operation of any third-party source, and **no warranty** that any
particular asset will be matched or enriched.

## 5. Your responsibilities

- You are responsible for the asset files you index and for your own rights to
  use them.
- You are responsible for complying with the terms of any third-party service
  you access through Omnidex (including Epic / FAB) using your own credentials.
- You should keep your locally stored Epic credentials file secure, as you
  would any other secret.

## 6. No warranty; limitation of liability

As stated in the MIT License, Omnidex is provided **"AS IS", without warranty of
any kind**, express or implied. To the maximum extent permitted by law, the
authors and copyright holders are **not liable** for any claim, damages, data
loss, service interruption, or other liability arising from your use of the
software or from the availability or behavior of any third-party service it
contacts.

## 7. Changes

These terms may be updated as the software evolves. The "Last updated" date
reflects the most recent revision; material changes will also be noted in the
changelog.
