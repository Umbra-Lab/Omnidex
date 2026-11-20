# Mirror vendor docs for agents

`scripts/docs-mirror/docs_mirror.py` copies the official docs for the tools you have installed to local markdown, pinned to your installed versions. It then indexes them into `docs.db`, which the [oracle MCP server](../subsystems/oracle-mcp.md) searches with its `docs_*` tools. Agents read and cite the real docs, in full, instead of reading part of a live page and guessing the rest.

It uses only the Python standard library (3.11 or later), and needs no API keys and no accounts.

## Check what is installed

```bash
python scripts/docs-mirror/docs_mirror.py versions
```

```
Mirror: C:\Users\you\AppData\Roaming\omnidex\docs-mirror
  blender              5.3                folder  C:\Program Files\Blender Foundation\Blender 5.3
  houdini              22.0.512           folder  C:\Program Files\Side Effects Software\Houdini 22.0.512
  unreal               5.8                folder  C:\Program Files\Epic Games\UE_5.8
```

Detection reads install folder names and never launches an app (`scripts/docs-mirror/versions.py`). Anything it misses or gets wrong, such as a portable Godot, goes in `versions.override.toml` in the mirror folder:

```toml
[versions]
godot = "4.7"
```

## Preview a crawl

```bash
python scripts/docs-mirror/docs_mirror.py fetch --product blender --dry-run
```

`--dry-run` lists each page it would save and its size, and writes no pages. It still records the detected versions in `versions.json`. Run it first for a new source. The entry points in `sources.toml` have not all been crawled end to end yet.

## Build the mirror

```bash
python scripts/docs-mirror/docs_mirror.py all
```

`all` runs `versions`, then `fetch`, then `index`. Each source is crawled once per docs version. A source that is already mirrored is skipped until you pass `--refresh`, which sends conditional requests and rewrites only the pages that changed.

| Flag | Effect |
|---|---|
| `--product NAME` | Only this product (repeatable) |
| `--source NAME` | Only this doc set, including disabled ones (repeatable) |
| `--refresh` | Re-check mirrored sources; changed pages are rewritten. A page is deleted only when the vendor answers 404 or 410 for it, or when it falls outside the source's `prefix` after a crawl with no failures |
| `--prune` | Allow a refresh to remove more than 10% of a doc set, or to remove pages after a start page has gone |
| `--delay S` | Seconds between requests to one host, default 1. A `Crawl-delay` in robots.txt overrides it when larger |
| `--mirror-dir DIR` | Default `<userData>/docs-mirror`, or `OMNIDEX_DOCS_MIRROR` |

Large references take a while at one request per second. Unity's scripting reference is capped at 6,000 pages in `sources.toml`; raise `max_pages` when you want all of it.

The crawler always honours `robots.txt`. The mirror is a personal cache: never commit it, share it, or ship it with Omnidex.

## Run it again when an app updates

A new install changes the detected version, and `fetch` then mirrors the new docs version into its own folder. `docs_versions` in the oracle flags any product whose installed version has no matching docs.

A refresh keeps the mirrored copy whenever the live site looks wrong rather than changed: a page that comes back nearly empty or without its links (a bot check, a JavaScript shell, a maintenance page), an unreadable `robots.txt`, a start page that has gone, or more than 10% of the doc set missing at once. The log says what it kept and why. If the vendor really did move or remove the docs, fix `sources.toml` or re-run with `--prune`.

Each run writes `CHANGES.md` beside a doc set, listing pages added, changed, removed and failed. Read it to see what the vendor changed.

## Pages rendered by JavaScript

Sources marked `mode = "auto"` (Epic, Adobe) are fetched as plain HTML first. If a page comes back nearly empty and [Crawl4AI](https://github.com/unclecode/crawl4ai) is installed, it is fetched again in a headless browser:

```bash
python -m pip install crawl4ai
crawl4ai-setup
```

Crawl4AI downloads Chromium, which takes several hundred MB of disk. Install it only when the log shows `only N chars without a browser`.

## Add a doc set

Add a `[[source]]` block to `scripts/docs-mirror/sources.toml`; the comment at the top documents every field. Keep `prefix` narrow. It is both the crawl boundary and the reason the mirror stays small.

## Tell agents to use it

Add this to a project's `CLAUDE.md` or `AGENTS.md`:

```markdown
For any API, flag or behaviour of Blender, Houdini, Unity, Unreal, Godot, Substance or
Cascadeur: search with `docs_search`, read the whole section with `docs_read` (follow
`next_offset` until `has_more: false`), and cite it as `path#anchor@version`. Check each
quote with `docs_verify`. If the docs do not say, answer "not in the local docs".
```

## Check it works

```bash
python -m unittest discover -s scripts/docs-mirror/tests
node scripts/oracle-mcp/docs-tools.test.mjs
```
