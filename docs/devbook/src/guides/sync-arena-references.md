# Sync Are.na references into Obsidian

`scripts/arena-sync/arena_sync.py` pulls your Are.na channels into an Obsidian vault. Each block becomes a note tagged by theme, with its image saved beside it, so an agent can open `Themes/lighting.md` and study every lighting reference you collected.

It uses only the Python standard library (3.11 or later). It runs without an account; a free personal token raises the request limit.

## Configure it

```bash
cp scripts/arena-sync/arena.example.toml scripts/arena-sync/arena.toml
```

Set `vault` to your vault folder. Then add one `[[channel]]` per channel, with the themes that apply to everything in it. `[keywords]` adds a theme to a single block when its title, description or source title contains one of the listed words. `arena.toml` is gitignored.

| Setting | Effect |
|---|---|
| `image_size` | `small`, `medium`, `large` (default), `square` or `original` |
| `download_images` | `true` saves images locally; `false` embeds Are.na's URL instead. Can be set per channel |
| `folder` | Where in the vault notes go, default `References/Are.na` |

## Add a token (optional)

As a guest you get 30 requests per minute. To get 120, create a personal access token with the `read` scope in your Are.na settings, then set it before running:

```bash
export ARENA_TOKEN=...        # PowerShell: $env:ARENA_TOKEN = "..."
```

The token is sent to the Are.na API only, never to image hosts, and is dropped if an API call redirects to another host. The script paces itself from the `X-RateLimit-*` headers either way.

## Run it

```bash
python scripts/arena-sync/arena_sync.py --config scripts/arena-sync/arena.toml
```

```
Refs (lighting-refs): 214 blocks
  new 214, updated 0, images 198, removed 0
```

`--dry-run` prints the same per-channel counts without writing notes, images or state. `--channel SLUG` (or a channel id) syncs only that channel and is repeatable.

A channel that fails, for example after repeated timeouts, is reported and skipped, the rest still sync, and the command exits with status 1.

## What it writes

```
References/Are.na/
├── .arena-sync.json            sync state
├── Themes/lighting.md          one list per theme, across channels
└── lighting-refs/
    ├── _index.md               every block in the channel
    ├── _images/12345.jpg
    └── 12345-rim-light-study.md
```

Each note's frontmatter has `arena_id`, `arena_url`, `source_url`, `channel`, `themes`, `tags`, `created_at` and `updated_at`.

Runs after the first are incremental:

- Unchanged blocks are skipped, and images are downloaded only once.
- A block removed from a channel keeps its note, marked `arena_removed: true`.
- Anything you write below the "your notes" marker in a note survives updates.

```admonish warning title="Are.na's terms on bulk downloading"
Are.na's acceptable-use terms prohibit "automated crawling, systematic downloading of content, or any form of structured data harvesting", and ask anyone who needs bulk data to contact them ([are.na/llms-full.txt](https://are.na/llms-full.txt)). Sync your own channels at a gentle pace, keep the vault private, and email Are.na before you sync large channels you do not own. Images belong to their creators.
```

## Check it works

```bash
python -m unittest discover -s scripts/arena-sync/tests
```
