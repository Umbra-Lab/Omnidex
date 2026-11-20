#!/usr/bin/env python3
"""Sync Are.na channels into an Obsidian vault as tagged reference notes.

    python scripts/arena-sync/arena_sync.py --config arena.toml [--dry-run]

Each block becomes one note under <vault>/<folder>/<channel>/ with frontmatter (Are.na id,
type, source URL, channel, themes, tags, dates) and, when enabled, the image downloaded
beside it so agents can look at the picture itself. Each channel gets an `_index.md` and each
theme a map-of-content note in <folder>/Themes/.

Re-running is incremental: unchanged blocks are skipped, images are fetched once, blocks
removed from a channel are marked `arena_removed: true` (never deleted), and anything you
write below the "your notes" marker in a note survives updates.

Standard library only (Python 3.11+). Are.na API v3; a personal access token in the
ARENA_TOKEN environment variable raises the read limit from 30 to 120 requests per minute.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import tomllib
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

API = os.environ.get("ARENA_API", "https://api.are.na/v3")
USER_AGENT = "omnidex-arena-sync/0.1 (personal reference vault)"
NOTES_MARKER = "<!-- arena-sync: anything below this line is yours and is kept on update -->"
IMAGE_SIZES = ("small", "medium", "large", "square", "original")


def log(msg: str) -> None:
    print(msg, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(s: str, n: int = 60) -> str:
    s = re.sub(r"[^\w\s-]", "", s.lower(), flags=re.U)
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:n].rstrip("-") or "untitled"


class Client:
    """Are.na API client that paces itself from the X-RateLimit-* headers."""

    def __init__(self, token: str | None):
        self.token = token
        # Guest: 30 reads/min; free token: 120 reads/min (Are.na llms-full.txt, 2026-11-20).
        self.min_interval = 0.55 if token else 2.05
        self._last = 0.0

    def _pace(self):
        wait = self._last + self.min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)

    def _open(self, url: str, accept: str, auth: bool):
        headers = {"User-Agent": USER_AGENT, "Accept": accept}
        # The token goes to API calls only, never to image hosts.
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        for attempt in range(5):
            self._pace()
            try:
                r = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)
                self._last = time.monotonic()
                self._respect_headers(r.headers)
                return r
            except urllib.error.HTTPError as e:
                self._last = time.monotonic()
                if e.code == 429 and attempt < 4:
                    delay = _reset_seconds(e.headers) or 30 * (attempt + 1)
                    log(f"  rate limited; waiting {delay:.0f}s")
                    time.sleep(delay)
                    continue
                if e.code >= 500 and attempt < 4:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise

    def _respect_headers(self, headers):
        remaining = headers.get("X-RateLimit-Remaining")
        if remaining is not None and remaining.strip().isdigit() and int(remaining) <= 1:
            delay = _reset_seconds(headers) or 60
            log(f"  rate limit nearly used; waiting {delay:.0f}s")
            time.sleep(delay)

    def get_json(self, path: str, **params) -> dict:
        url = f"{API}{path}" + (f"?{urlencode(params)}" if params else "")
        with self._open(url, "application/json", auth=True) as r:
            return json.loads(r.read().decode("utf-8"))

    def download(self, url: str, dest: Path) -> str:
        with self._open(url, "image/*,*/*", auth=False) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(data)
        os.replace(tmp, dest)
        return ctype


def _reset_seconds(headers) -> float | None:
    raw = headers.get("Retry-After") or headers.get("X-RateLimit-Reset")
    if not raw:
        return None
    try:
        v = float(raw)
    except ValueError:
        return None
    # Reset may be an epoch timestamp or a number of seconds.
    return max(1.0, v - time.time()) if v > 1e9 else max(1.0, v)


# ---------------------------------------------------------------------------- blocks


def text_of(value) -> str:
    """Are.na text fields are either strings or {markdown, plain, html} objects."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("markdown") or value.get("plain") or ""
    return str(value)


def image_url(block: dict, size: str) -> str | None:
    img = block.get("image") or {}
    if not isinstance(img, dict):
        return None
    if size != "original":
        variant = img.get(size)
        if isinstance(variant, dict) and variant.get("src"):
            return variant["src"]
    return img.get("src") or (img.get("original") or {}).get("url")


def image_ext(block: dict, url: str, content_type: str = "") -> str:
    img = block.get("image") or {}
    for candidate in (content_type.split(";")[0].strip(), img.get("content_type") or ""):
        ext = mimetypes.guess_extension(candidate) if candidate else None
        if ext:
            return ".jpg" if ext in (".jpe", ".jpeg") else ext
    path_ext = os.path.splitext(urlsplit(url).path)[1].lower()
    return path_ext if re.fullmatch(r"\.\w{2,5}", path_ext or "") else ".jpg"


def themes_for(block: dict, channel_themes: list[str], keywords: dict[str, list[str]]) -> list[str]:
    hay = " ".join([
        text_of(block.get("title")), text_of(block.get("description")),
        text_of((block.get("source") or {}).get("title")) if isinstance(block.get("source"), dict) else "",
    ]).lower()
    out = list(channel_themes)
    for theme, words in keywords.items():
        if theme not in out and any(re.search(rf"\b{re.escape(w.lower())}\b", hay) for w in words):
            out.append(theme)
    return out


def render_note(block: dict, channel: dict, themes: list[str], image_rel: str | None,
                image_remote: str | None, removed: bool, user_notes: str) -> str:
    source = block.get("source") if isinstance(block.get("source"), dict) else {}
    title = text_of(block.get("title")) or source.get("title") or f"Block {block['id']}"
    arena_url = f"https://www.are.na/block/{block['id']}"
    meta = {
        "arena_id": block["id"],
        "arena_type": block.get("type"),
        "arena_url": arena_url,
        "source_url": source.get("url"),
        "channel": channel["slug"],
        "channel_title": channel.get("title"),
        "themes": themes,
        "tags": ["arena", f"arena/{channel['slug']}"] + [f"theme/{slugify(t)}" for t in themes],
        "created_at": block.get("created_at"),
        "updated_at": block.get("updated_at"),
        "fetched_at": now_iso(),
        "image": image_rel,
        "arena_removed": True if removed else None,
    }
    lines = ["---"]
    lines += [f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in meta.items() if v is not None]
    lines += ["---", "", f"# {title}", ""]
    if image_rel:
        lines += [f"![[{image_rel}]]", ""]
    elif image_remote:
        lines += [f"![{title}]({image_remote})", ""]
    desc = text_of(block.get("description")).strip()
    if desc:
        lines += [desc, ""]
    content = text_of(block.get("content")).strip()
    if content and block.get("type") == "Text":
        lines += [content, ""]
    if source.get("url"):
        lines += [f"Source: [{source.get('title') or source['url']}]({source['url']})", ""]
    lines += [f"Are.na: [{block['id']}]({arena_url}) in [[{channel['slug']}/_index|{channel.get('title') or channel['slug']}]]", ""]
    if themes:
        lines += ["Themes: " + ", ".join(f"[[Themes/{slugify(t)}|{t}]]" for t in themes), ""]
    lines += [NOTES_MARKER, user_notes.lstrip("\n")]
    return "\n".join(lines).rstrip() + "\n"


def existing_user_notes(path: Path) -> str:
    if not path.is_file():
        return ""
    text = path.read_text(encoding="utf-8")
    _, marker, rest = text.partition(NOTES_MARKER)
    return rest if marker else ""


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------------------- sync


def list_contents(client: Client, channel_id) -> list[dict]:
    items, page = [], 1
    while True:
        data = client.get_json(f"/channels/{channel_id}/contents", page=page, per=100,
                               sort="position_desc")
        items += data.get("data", [])
        meta = data.get("meta") or {}
        if not meta.get("has_more_pages"):
            return items
        page = meta.get("next_page") or page + 1


def sync_channel(client: Client, cfg: dict, ch_cfg: dict, root: Path, state: dict,
                 dry_run: bool) -> None:
    ref = ch_cfg.get("slug") or ch_cfg.get("id")
    info = client.get_json(f"/channels/{ref}")
    channel = {"slug": info.get("slug") or str(ref), "title": info.get("title") or str(ref),
               "id": info.get("id")}
    folder = root / channel["slug"]
    ch_state = state.setdefault(channel["slug"], {"blocks": {}})
    download = ch_cfg.get("download_images", cfg.get("download_images", True))
    size = ch_cfg.get("image_size", cfg.get("image_size", "large"))
    if size not in IMAGE_SIZES:
        raise SystemExit(f"image_size must be one of {IMAGE_SIZES}, got {size!r}")
    blocks = [b for b in list_contents(client, channel["id"] or ref)
              if (b.get("base_type") or "Block") != "Channel"]
    log(f"{channel['title']} ({channel['slug']}): {len(blocks)} blocks")
    seen = set()
    new = updated = images = 0
    for block in blocks:
        bid = str(block["id"])
        seen.add(bid)
        prev = ch_state["blocks"].get(bid, {})
        rel_note = prev.get("note") or f"{channel['slug']}/{bid}-{slugify(text_of(block.get('title')) or 'block')}.md"
        note_path = root / rel_note
        themes = themes_for(block, list(ch_cfg.get("themes", [])), cfg.get("keywords", {}))
        remote = image_url(block, size)
        image_rel = prev.get("image")
        if download and remote and not (image_rel and (root / channel["slug"] / image_rel).is_file()):
            image_rel = f"_images/{bid}{image_ext(block, remote)}"
            if not dry_run:
                try:
                    client.download(remote, folder / image_rel)
                    images += 1
                except (urllib.error.URLError, OSError) as e:
                    log(f"  ! image for block {bid} failed: {e}")
                    image_rel = None
        changed = (prev.get("updated_at") != block.get("updated_at") or prev.get("themes") != themes
                   or prev.get("image") != image_rel or prev.get("removed") or not note_path.is_file())
        if changed and not dry_run:
            text = render_note(block, channel, themes, image_rel, None if image_rel else remote, False,
                               existing_user_notes(note_path))
            write_atomic(note_path, text)
        if changed:
            new += not prev
            updated += bool(prev)
        ch_state["blocks"][bid] = {"note": rel_note, "updated_at": block.get("updated_at"),
                                   "themes": themes, "image": image_rel,
                                   "title": text_of(block.get("title")) or f"Block {bid}"}
    removed = 0
    for bid, prev in ch_state["blocks"].items():
        if bid in seen or prev.get("removed"):
            continue
        removed += 1
        prev["removed"] = True
        path = root / prev["note"]
        if path.is_file() and not dry_run:
            text = path.read_text(encoding="utf-8")
            if "arena_removed:" not in text:
                write_atomic(path, text.replace("\n---\n", "\narena_removed: true\n---\n", 1))
    ch_state["title"] = channel["title"]
    ch_state["synced_at"] = now_iso()
    log(f"  new {new}, updated {updated}, images {images}, removed {removed}")
    if not dry_run:
        write_channel_index(root, channel, ch_state)


def write_channel_index(root: Path, channel: dict, ch_state: dict) -> None:
    lines = [f"# {channel['title']}", "", f"Are.na channel `{channel['slug']}`, synced "
             f"{ch_state['synced_at'][:10]}.", ""]
    for bid, b in sorted(ch_state["blocks"].items(), key=lambda kv: kv[1]["note"]):
        if b.get("removed"):
            continue
        name = Path(b["note"]).stem
        lines.append(f"- [[{channel['slug']}/{name}|{b['title']}]]")
    write_atomic(root / channel["slug"] / "_index.md", "\n".join(lines) + "\n")


def write_theme_mocs(root: Path, state: dict) -> None:
    themes: dict[str, list[tuple[str, str]]] = {}
    for slug, ch in state.items():
        for b in ch.get("blocks", {}).values():
            if b.get("removed"):
                continue
            for t in b.get("themes", []):
                themes.setdefault(t, []).append((b["note"], b["title"]))
    for theme, notes in themes.items():
        lines = [f"# {theme}", "", f"{len(notes)} references tagged `{theme}`.", ""]
        for note, title in sorted(notes):
            lines.append(f"- [[{note[:-3]}|{title}]]")
        write_atomic(root / "Themes" / f"{slugify(theme)}.md", "\n".join(lines) + "\n")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", required=True, help="arena.toml (see arena.example.toml)")
    p.add_argument("--channel", action="append", help="only these channel slugs")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    with open(args.config, "rb") as f:
        cfg = tomllib.load(f)
    root = Path(cfg["vault"]).expanduser() / cfg.get("folder", "References/Are.na")
    state_path = root / ".arena-sync.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.is_file() else {}
    token = os.environ.get(cfg.get("token_env", "ARENA_TOKEN")) or None
    client = Client(token)
    if not token:
        log("No ARENA_TOKEN set: reading as a guest (30 requests/minute).")
    channels = cfg.get("channel", [])
    if args.channel:
        channels = [c for c in channels if c.get("slug") in args.channel]
    if not channels:
        log("No channels configured.")
        return 1
    for ch in channels:
        try:
            sync_channel(client, cfg, ch, root, state, args.dry_run)
        except urllib.error.HTTPError as e:
            log(f"! {ch.get('slug')}: HTTP {e.code} {e.reason}")
        if not args.dry_run:
            write_atomic(state_path, json.dumps(state, indent=1))
    if not args.dry_run:
        write_theme_mocs(root, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
