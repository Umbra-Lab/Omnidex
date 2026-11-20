#!/usr/bin/env python3
"""Local, versioned mirror of vendor documentation for AI agents.

    python scripts/docs-mirror/docs_mirror.py versions          # what is installed
    python scripts/docs-mirror/docs_mirror.py fetch [--product blender] [--source manual]
    python scripts/docs-mirror/docs_mirror.py index             # rebuild docs.db
    python scripts/docs-mirror/docs_mirror.py all               # versions + fetch + index
    python scripts/docs-mirror/docs_mirror.py status

Pages are saved as markdown under <mirror>/docs/<product>/<version>/<source>/... with
frontmatter (source_url, version, fetched_at, sha256, kind). `index` chunks them by heading
into <mirror>/docs.db (SQLite FTS5), which the Omnidex Oracle MCP server reads.

Standard library only. Crawl4AI is used for `mode = "browser"|"auto"` sources when it is
installed (`pip install crawl4ai`); without it those sources fall back to plain HTTP.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import re
import sqlite3
import sys
import time
import tomllib
import urllib.error
import urllib.request
import urllib.robotparser
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, quote, unquote, urlencode, urljoin, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import html2md  # noqa: E402
import versions as versions_mod  # noqa: E402

USER_AGENT = "omnidex-docs-mirror/0.1 (personal local documentation cache)"
HERE = Path(__file__).resolve().parent
SCHEMA_VERSION = 1
# Pages whose extracted text is shorter than this are treated as "rendered by JavaScript".
MIN_CONTENT_CHARS = 400


def default_mirror_dir() -> Path:
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "omnidex" / "docs-mirror"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------------------- sources


def load_sources(path: Path) -> list[dict]:
    with path.open("rb") as f:
        data = tomllib.load(f)
    out = []
    for s in data.get("source", []):
        s.setdefault("kind", "reference")
        s.setdefault("versioned", True)
        s.setdefault("crawl", True)
        s.setdefault("format", "html")
        s.setdefault("mode", "static")
        s.setdefault("selectors", [])
        s.setdefault("max_pages", 2000)
        s.setdefault("enabled", True)
        s.setdefault("prefer_md", False)
        out.append(s)
    return out


def resolve(source: dict, installed: dict) -> tuple[str, dict] | None:
    """Return (doc_version, source with {version} filled) or None when not applicable."""
    info = installed.get(source["product"])
    if info is None:
        return None
    if source["versioned"]:
        dv = versions_mod.doc_version(info.get("version"))
        if dv is None:
            log(f"  skip {source['product']}/{source['name']}: installed version unknown "
                f"(set it in versions.override.toml)")
            return None
    else:
        dv = "current"

    def fill(v):
        if isinstance(v, str):
            return v.replace("{version}", dv)
        if isinstance(v, list):
            return [fill(x) for x in v]
        return v

    return dv, {k: fill(v) for k, v in source.items()}


# ---------------------------------------------------------------------------- HTTP


class Fetcher:
    def __init__(self, delay: float):
        self.delay = delay
        self._last: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            try:
                req = urllib.request.Request(origin + "/robots.txt", headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=20) as r:
                    rp.parse(r.read().decode("utf-8", "replace").splitlines())
                self._robots[origin] = rp
            except urllib.error.HTTPError as e:
                # 404/410: the site has no robots.txt, so everything is allowed (RFC 9309).
                # 401/403/5xx or anything else: we cannot read the rules, so fetch nothing.
                self._robots[origin] = None if e.code in (404, 410) else _deny_all()
            except Exception:
                self._robots[origin] = _deny_all()
        rp = self._robots[origin]
        if rp is None:
            return True
        crawl_delay = rp.crawl_delay(USER_AGENT)
        if crawl_delay and crawl_delay > self.delay:
            self.delay = float(crawl_delay)
        return rp.can_fetch(USER_AGENT, url)

    def get(self, url: str, etag: str | None = None, last_modified: str | None = None):
        """Return (status, body_text, headers, final_url). 304 returns (304, None, ...).

        Non-text responses (images, archives, PDFs) come back as status -1 and are never
        read into memory.
        """
        host = urlsplit(url).netloc
        wait = self._last.get(host, 0) + self.delay - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,text/markdown,text/plain"}
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        req = urllib.request.Request(url, headers=headers)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    self._last[host] = time.monotonic()
                    ctype = (r.headers.get_content_type() or "").lower()
                    if ctype not in TEXT_TYPES:
                        return -1, None, dict(r.headers), r.geturl()
                    raw = r.read(MAX_PAGE_BYTES + 1)
                    if len(raw) > MAX_PAGE_BYTES:
                        return -1, None, dict(r.headers), r.geturl()
                    charset = r.headers.get_content_charset() or "utf-8"
                    try:
                        text = raw.decode(charset, "replace")
                    except LookupError:
                        text = raw.decode("utf-8", "replace")
                    return r.status, text, dict(r.headers), r.geturl()
            except urllib.error.HTTPError as e:
                self._last[host] = time.monotonic()
                if e.code == 304:
                    return 304, None, dict(e.headers), url
                if e.code in (429, 503) and attempt < 3:
                    retry = e.headers.get("Retry-After")
                    time.sleep(float(retry) if retry and retry.isdigit() else 10 * (attempt + 1))
                    continue
                return e.code, None, dict(e.headers), url
            except (OSError, http.client.HTTPException, ValueError) as e:
                # URLError, timeouts, resets, IncompleteRead, bad URLs: retry, then give up on
                # this page only.
                if attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                log(f"    ! {url}: {e}")
                return 0, None, {}, url
        return 0, None, {}, url


TEXT_TYPES = {"text/html", "application/xhtml+xml", "text/markdown", "text/x-markdown", "text/plain"}
MAX_PAGE_BYTES = 8 * 1024 * 1024
BINARY_EXT = re.compile(
    r"\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|pdf|zip|7z|gz|tgz|bz2|xz|rar|exe|msi|dmg|pkg|"
    r"mp4|mov|webm|mp3|wav|ogg|woff2?|ttf|otf|eot|css|js|json|xml|rss|atom|blend|fbx|obj|"
    r"uasset|hip|hda|sbs|sbsar|spp|unitypackage|txt)$", re.I)


def _deny_all():
    rp = urllib.robotparser.RobotFileParser()
    rp.parse(["User-agent: *", "Disallow: /"])
    return rp


def browser_html(url: str) -> str | None:
    """Rendered HTML via Crawl4AI, or None when it is not installed or fails."""
    try:
        import asyncio

        from crawl4ai import AsyncWebCrawler  # type: ignore
    except ImportError:
        return None

    async def run():
        async with AsyncWebCrawler() as crawler:
            result = await crawler.arun(url=url)
            return getattr(result, "html", None) if getattr(result, "success", False) else None

    try:
        return asyncio.run(run())
    except Exception as e:  # browser missing, navigation error, ...
        log(f"    ! browser fetch failed for {url}: {e}")
        return None


# ---------------------------------------------------------------------------- paths

WINDOWS_RESERVED = re.compile(r"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", re.I)


def url_to_relpath(url: str, prefixes: list[str]) -> str:
    """Stable file path for a URL, relative to the source folder.

    The path below the matching prefix is kept; with no matching prefix (fixed page lists)
    the host and full path are used, so two pages never share a file.
    """
    parts = urlsplit(url)
    path = unquote(parts.path)
    for p in prefixes:
        pp = unquote(urlsplit(p).path)
        if urlsplit(p).netloc == parts.netloc and path.startswith(pp) and pp:
            path = path[len(pp):]
            break
    else:
        path = parts.netloc + path
    path = path.strip("/")
    if not path or parts.path.endswith("/"):
        path = (path + "/index").strip("/")
    path = re.sub(r"\.(html?|php|aspx?|md)$", "", path, flags=re.I)
    # Keep a query that selects content, minus the version, which the folder already carries.
    q = re.sub(r"(^|&)application_version=[^&]*", "", parts.query).strip("&")
    if q:
        path += "__" + re.sub(r"[^\w.-]+", "_", q)
    segs = []
    for seg in path.split("/"):
        seg = re.sub(r'[<>:"\\|?*\x00-\x1f]', "_", seg)[:120].rstrip(". ") or "_"
        if seg in (".", "..") or WINDOWS_RESERVED.match(seg):
            seg = "_" + seg
        segs.append(seg)
    return "/".join(segs) + ".md"


def in_scope(url: str, prefixes: list[str]) -> bool:
    return any(url.startswith(p) for p in prefixes) and not BINARY_EXT.search(urlsplit(url).path)


def normalize(url: str, pin_query: str | None = None) -> str:
    """Canonical URL: no fragment, `.`/`..` segments resolved, and for sources that pin a
    version by query (Epic's `application_version`) that parameter forced to the pinned
    value, so a link that omits it or names another version still lands on this version."""
    url = url.split("#", 1)[0]
    parts = urlsplit(url)
    segs = []
    for seg in unquote(parts.path).split("/"):
        if seg == "..":
            if len(segs) > 1:
                segs.pop()
        elif seg != ".":
            segs.append(seg)
    path = "/".join(segs)
    query = parts.query
    if pin_query:
        key, _, value = pin_query.partition("=")
        params = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True) if k != key]
        query = urlencode(params + [(key, value)])
    return parts._replace(path=quote(path, safe="/%:@!$&'()*+,;=-._~"), query=query).geturl()


# ---------------------------------------------------------------------------- frontmatter


def write_page(path: Path, meta: dict, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["---"]
    for k, v in meta.items():
        if v is None:
            continue
        lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    lines.append("---")
    tmp = path.with_suffix(".md.tmp")
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    tmp.write_text("\n".join(lines) + "\n\n" + body, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def read_page(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    meta: dict = {}
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].split("\n"):
                k, _, v = line.partition(": ")
                try:
                    meta[k] = json.loads(v)
                except json.JSONDecodeError:
                    meta[k] = v
            text = text[end + 5:].lstrip("\n")
    return meta, text


# ---------------------------------------------------------------------------- fetch

MANIFEST_FLUSH_EVERY = 50


def fetch_source(src: dict, product_version: str, doc_version: str, mirror: Path,
                 fetcher: Fetcher, refresh: bool, dry_run: bool) -> dict:
    root = mirror / "docs" / src["product"] / doc_version / src["name"]
    manifest_path = root / "_manifest.json"
    manifest: dict = {}
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pages: dict = manifest.get("pages", {})
    if pages and manifest.get("complete") and not refresh:
        log(f"  {src['product']}/{doc_version}/{src['name']}: already mirrored "
            f"({len(pages)} pages, {manifest.get('fetched_at')}); use --refresh to update")
        return {"skipped": True}

    pin = src.get("pin_query")
    prefixes = [normalize(p) for p in src.get("prefix", [])]
    queue = deque(dict.fromkeys(normalize(u, pin) for u in (src.get("start", []) if src["crawl"]
                                                             else src.get("pages", []))))
    seen = set(queue)
    added, changed, unchanged, failed, removed = [], [], [], [], []
    blocked = 0
    visited_urls = set()
    path_owner: dict[str, str] = {e["path"]: u for u, e in pages.items()}
    count = 0
    resumed = bool(pages) and not manifest.get("complete") and not refresh
    log(f"  {src['product']}/{doc_version}/{src['name']}: {'dry run, ' if dry_run else ''}"
        f"{'resuming, ' if resumed else ''}from {len(queue)} start page(s), cap {src['max_pages']}")

    def enqueue(links):
        for link in links:
            if link not in seen and in_scope(link, prefixes):
                seen.add(link)
                queue.append(link)

    def flush(complete: bool):
        if dry_run:
            return
        root.mkdir(parents=True, exist_ok=True)
        data = {"source": src["name"], "product": src["product"], "doc_version": doc_version,
                "product_version": product_version, "fetched_at": now_iso(),
                "complete": complete, "pages": pages}
        tmp = manifest_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
        os.replace(tmp, manifest_path)

    completed = False
    try:
        while queue and count < src["max_pages"]:
            url = queue.popleft()
            prev = pages.get(url, {})
            if not fetcher.allowed(url):
                log(f"    robots.txt disallows {url}")
                if prev:
                    # A page we hold is now off limits: keep it and what it links to, and
                    # don't trust absence as removal this run.
                    blocked += 1
                    enqueue(prev.get("links", []))
                continue
            if resumed and prev:
                # An interrupted crawl: pages already saved this round are not fetched again.
                enqueue(prev.get("links", []))
                continue
            count += 1
            try:
                outcome = _fetch_one(src, url, prev, fetcher, prefixes, pin)
            except Exception as e:  # one bad page never ends the crawl
                log(f"    ! {url}: {type(e).__name__}: {e}")
                outcome = {"status": 0}
            visited_urls.add(url)
            status = outcome["status"]
            if status == 304:
                unchanged.append(url)
                # Pages reachable only through this one must still be visited (and not be
                # mistaken for removed ones).
                enqueue(prev.get("links", []))
                continue
            if status != 200:
                # Visit what this page linked to last time either way, so each of those pages
                # is checked on its own instead of being dropped with its parent.
                enqueue(prev.get("links", []))
                if status in (404, 410) and prev:
                    removed.append(url)
                    if not dry_run:
                        _remove_page(root, pages, path_owner, url)
                else:
                    failed.append((url, status))
                continue
            enqueue(outcome["links"])
            rel = url_to_relpath(url, prefixes)
            owner = path_owner.get(rel)
            if owner and owner != url:
                log(f"    = {url} is the same file as {owner}; skipped")
                continue
            if dry_run:
                log(f"    {rel}  ({len(outcome['md']):,} chars)")
                continue
            digest = hashlib.sha256(outcome["md"].encode("utf-8")).hexdigest()
            entry = {"path": rel, "sha256": digest, "etag": outcome["etag"],
                     "last_modified": outcome["last_modified"], "title": outcome["title"],
                     "links": outcome["links"]}
            path_owner[rel] = url
            if prev.get("sha256") == digest and (root / rel).is_file():
                unchanged.append(url)
                pages[url] = {**prev, **entry}
                continue
            (changed if prev else added).append(url)
            meta = {"title": outcome["title"], "source_url": url, "product": src["product"],
                    "product_version": product_version, "doc_version": doc_version,
                    "doc_set": src["name"], "kind": src["kind"], "fetched_at": now_iso(),
                    "sha256": digest, "last_updated": outcome["last_updated"]}
            target = (root / rel).resolve()
            if root.resolve() not in target.parents:
                failed.append((url, "path outside mirror"))
                continue
            write_page(target, meta, outcome["md"])
            pages[url] = {**entry, "fetched_at": meta["fetched_at"]}
            if (len(added) + len(changed)) % MANIFEST_FLUSH_EVERY == 0:
                flush(False)

        # Removal by absence is only trusted after a crawl that finished, reached every page
        # it was allowed to, and had no failures. Anything less keeps the existing pages.
        clean = src["crawl"] and not queue and not failed and not blocked and not dry_run
        if clean:
            for url in list(pages):
                if url not in visited_urls and url not in seen:
                    removed.append(url)
                    _remove_page(root, pages, path_owner, url)
        elif src["crawl"] and (failed or blocked) and not dry_run:
            log("    some pages failed or were blocked: kept pages the crawl did not reach")
        completed = not queue
    finally:
        flush(completed)
        if not dry_run:
            write_changes(root, added, changed, removed, failed, pages)
    if queue:
        log(f"    stopped at max_pages={src['max_pages']} with {len(queue)} URL(s) left; "
            f"the next run resumes")
    log(f"    added {len(added)}, changed {len(changed)}, unchanged {len(unchanged)}, "
        f"removed {len(removed)}, failed {len(failed)}")
    return {"added": added, "changed": changed, "removed": removed, "failed": failed}


def _remove_page(root: Path, pages: dict, path_owner: dict, url: str) -> None:
    rel = pages[url]["path"]
    del pages[url]
    # Never delete a file another URL still maps to.
    if path_owner.get(rel) == url or not any(e["path"] == rel for e in pages.values()):
        path_owner.pop(rel, None)
        stale = root / rel
        if stale.is_file():
            stale.unlink()


def _fetch_one(src: dict, url: str, prev: dict, fetcher: Fetcher, prefixes: list[str],
               pin: str | None) -> dict:
    fetch_url = url + ".md" if src["prefer_md"] and not urlsplit(url).path.endswith(".md") else url
    status, body, headers, final = fetcher.get(fetch_url, prev.get("etag"), prev.get("last_modified"))
    if status != 200 and status != 304 and fetch_url != url:
        fetch_url = url
        status, body, headers, final = fetcher.get(url, prev.get("etag"), prev.get("last_modified"))
    if status != 200 or body is None:
        return {"status": status}
    final_n = normalize(final, pin)
    if final_n != normalize(fetch_url, pin) and prefixes and not in_scope(final_n, prefixes):
        # Redirected to another version, a login page or another site: not this doc set.
        log(f"    ! {url} redirected out of scope to {final}")
        return {"status": "redirected"}
    ctype = headers.get("Content-Type", "")
    is_md = src["format"] == "markdown" or urlsplit(fetch_url).path.endswith(".md") or \
        "markdown" in ctype
    html = None
    if is_md:
        title_m = re.search(r"^#\s+(.+)$", body, re.M)
        title, md = (title_m.group(1).strip() if title_m else url), body
    else:
        html = body
        title, md = html2md.extract(html, final, src["selectors"])
        if src["mode"] == "browser" or (src["mode"] == "auto" and len(md) < MIN_CONTENT_CHARS):
            rendered = browser_html(url)
            if rendered:
                html = rendered
                title, md = html2md.extract(html, url, src["selectors"])
            elif src["mode"] == "auto" and len(md) < MIN_CONTENT_CHARS:
                log(f"    ~ {url}: only {len(md)} chars without a browser (install crawl4ai)")
    links = []
    if src["crawl"]:
        if html is not None:
            raw = html2md.links(html, final)
        else:
            raw = [urljoin(final, re.sub(r"\.md$", "", u))
                   for u in re.findall(r"\]\(<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\)", body)
                   if not u.startswith(("#", "mailto:"))]
        me = normalize(url, pin)
        links = sorted({n for n in (normalize(u, pin) for u in raw)
                        if n != me and in_scope(n, prefixes)})
    return {"status": 200, "md": md, "title": title, "links": links,
            "etag": headers.get("ETag"), "last_modified": headers.get("Last-Modified"),
            "last_updated": _md_last_updated(md) if is_md else None}


def _md_last_updated(md: str) -> str | None:
    m = re.search(r"^last_updated:\s*\"?([^\"\n]+)", md, re.M)
    return m.group(1).strip() if m else None


def write_changes(root: Path, added, changed, removed, failed, pages) -> None:
    if not (added or changed or removed or failed):
        return
    stamp = now_iso()
    lines = [f"## {stamp}", ""]
    for label, urls in (("Added", added), ("Changed", changed), ("Removed", removed)):
        if urls:
            lines.append(f"### {label} ({len(urls)})")
            lines += [f"- {pages.get(u, {}).get('path', '')} <{u}>" for u in urls[:500]]
            if len(urls) > 500:
                lines.append(f"- ... and {len(urls) - 500} more")
            lines.append("")
    if failed:
        lines.append(f"### Failed ({len(failed)})")
        lines += [f"- HTTP {code or 'error'} <{u}>" for u, code in failed[:200]]
        lines.append("")
    path = root / "CHANGES.md"
    old = path.read_text(encoding="utf-8") if path.is_file() else "# Changes\n\n"
    head, _, rest = old.partition("\n\n")
    path.write_text(head + "\n\n" + "\n".join(lines) + "\n" + rest, encoding="utf-8")


# ---------------------------------------------------------------------------- index

SYMBOL_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z_][A-Za-z0-9_]*)+\b|"
                       r"\b[A-Za-z]+_[A-Za-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


def split_sections(md: str) -> list[dict]:
    """Split markdown at headings (outside code fences). Text before the first heading is
    section 0 with an empty heading."""
    sections = [{"heading": "", "level": 0, "lines": []}]
    fence = None
    for line in md.split("\n"):
        stripped = line.lstrip()
        if fence:
            # A fence closes only with the same character, at least as long, and nothing else.
            if stripped.startswith(fence) and not stripped.rstrip().strip(fence[0]):
                fence = None
        elif m := re.match(r"(`{3,}|~{3,})", stripped):
            fence = m.group(1)
        elif m := HEADING_RE.match(line):
            sections.append({"heading": _plain(m.group(2)), "level": len(m.group(1)), "lines": [line]})
            continue
        sections[-1]["lines"].append(line)
    out = []
    used = {}
    for s in sections:
        body = "\n".join(s["lines"]).strip("\n")
        if not body.strip() and not s["heading"]:
            continue
        anchor = re.sub(r"[^\w\- ]", "", s["heading"].lower()).strip().replace(" ", "-") or "top"
        n = used.get(anchor, 0)
        used[anchor] = n + 1
        if n:
            anchor = f"{anchor}-{n}"
        out.append({"heading": s["heading"], "level": s["level"], "anchor": anchor, "body": body})
    return out


def _plain(s: str) -> str:
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    return s.replace("`", "").replace("**", "").replace("*", "").strip()


def symbols(text: str) -> str:
    found = set()
    for m in SYMBOL_RE.finditer(text):
        sym = m.group(0)
        found.add(sym)
        if "." in sym or "::" in sym:
            found.add(re.split(r"\.|::", sym)[-1])
    return " ".join(sorted(found))[:20000]


def build_index(mirror: Path, installed: dict) -> Path:
    docs = mirror / "docs"
    db_path = mirror / "docs.db"
    tmp = mirror / "docs.db.tmp"
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    con.executescript("""
        PRAGMA journal_mode = OFF;
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE pages (
          id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, product TEXT NOT NULL,
          doc_version TEXT NOT NULL, product_version TEXT, doc_set TEXT NOT NULL,
          kind TEXT NOT NULL, title TEXT NOT NULL, source_url TEXT NOT NULL,
          fetched_at TEXT NOT NULL, last_updated TEXT, chars INTEGER NOT NULL);
        CREATE TABLE sections (
          id INTEGER PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id),
          ord INTEGER NOT NULL, heading TEXT NOT NULL, level INTEGER NOT NULL,
          anchor TEXT NOT NULL, body TEXT NOT NULL, symbols TEXT NOT NULL,
          start_char INTEGER NOT NULL, chars INTEGER NOT NULL);
        CREATE INDEX sections_page ON sections(page_id, ord);
        CREATE INDEX pages_product ON pages(product, doc_version);
        -- No porter stemming and '_' kept inside tokens, so API names such as
        -- primitive_cube_add or createNode stay whole.
        CREATE VIRTUAL TABLE sections_fts USING fts5(
          heading, symbols, body, content='sections', content_rowid='id',
          tokenize = "unicode61 tokenchars '_'");
    """)
    n_pages = n_sections = 0
    if docs.is_dir():
        for md_path in sorted(docs.rglob("*.md")):
            if md_path.name == "CHANGES.md":
                continue
            meta, body = read_page(md_path)
            if "source_url" not in meta:
                continue
            rel = md_path.relative_to(docs).as_posix()
            cur = con.execute(
                "INSERT INTO pages (path, product, doc_version, product_version, doc_set, kind, title,"
                " source_url, fetched_at, last_updated, chars) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (rel, meta.get("product", rel.split("/")[0]), meta.get("doc_version", ""),
                 meta.get("product_version"), meta.get("doc_set", ""), meta.get("kind", "reference"),
                 meta.get("title") or rel, meta["source_url"], meta.get("fetched_at", ""),
                 meta.get("last_updated"), len(body)))
            page_id = cur.lastrowid
            n_pages += 1
            pos = 0
            for i, s in enumerate(split_sections(body)):
                start = body.find(s["body"], pos)
                start = pos if start < 0 else start
                pos = start + len(s["body"])
                con.execute(
                    "INSERT INTO sections (page_id, ord, heading, level, anchor, body, symbols,"
                    " start_char, chars) VALUES (?,?,?,?,?,?,?,?,?)",
                    (page_id, i, s["heading"], s["level"], s["anchor"], s["body"],
                     symbols(s["heading"] + "\n" + s["body"]), start, len(s["body"])))
                n_sections += 1
    con.execute("INSERT INTO sections_fts(sections_fts) VALUES ('rebuild')")
    con.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("schema_version", str(SCHEMA_VERSION)),
        ("built_at", now_iso()),
        ("installed", json.dumps(installed)),
        ("pages", str(n_pages)),
        ("sections", str(n_sections)),
    ])
    con.commit()
    con.close()
    try:
        os.replace(tmp, db_path)
    except PermissionError:
        # Windows refuses to replace a file another process has open. The Oracle server opens
        # docs.db per call, so this only happens mid-query: retry once.
        time.sleep(2)
        os.replace(tmp, db_path)
    log(f"Indexed {n_pages:,} pages, {n_sections:,} sections -> {db_path}")
    return db_path


# ---------------------------------------------------------------------------- CLI


def cmd_versions(mirror: Path) -> dict:
    installed = versions_mod.load(mirror)
    if not installed:
        log("No supported apps detected. Add them to versions.override.toml in " + str(mirror))
    for product, info in sorted(installed.items()):
        log(f"  {product:20} {info.get('version') or '(version unknown)':18} {info.get('source')}  "
            f"{info.get('path', '')}")
    mirror.mkdir(parents=True, exist_ok=True)
    (mirror / "versions.json").write_text(json.dumps(installed, indent=1), encoding="utf-8")
    return installed


def cmd_fetch(args, mirror: Path, installed: dict) -> None:
    sources = load_sources(Path(args.sources))
    fetcher = Fetcher(args.delay)
    ran = 0
    for src in sources:
        if args.product and src["product"] not in args.product:
            continue
        if args.source and src["name"] not in args.source:
            continue
        if not src["enabled"] and not args.source:
            continue
        resolved = resolve(src, installed)
        if resolved is None:
            continue
        doc_version, filled = resolved
        product_version = installed[src["product"]].get("version")
        fetch_source(filled, product_version, doc_version, mirror, fetcher, args.refresh, args.dry_run)
        ran += 1
    if ran == 0:
        log("No sources matched an installed product. Run `versions`, or add the product to "
            "versions.override.toml.")


def cmd_status(mirror: Path) -> None:
    db = mirror / "docs.db"
    if not db.is_file():
        log(f"No index at {db}. Run `all`.")
        return
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    built = con.execute("SELECT value FROM meta WHERE key='built_at'").fetchone()[0]
    log(f"Index built {built}")
    for row in con.execute("SELECT product, doc_version, doc_set, COUNT(*), MIN(fetched_at), "
                           "MAX(fetched_at), SUM(chars) FROM pages GROUP BY 1,2,3 ORDER BY 1,2,3"):
        log(f"  {row[0]}/{row[1]}/{row[2]}: {row[3]:,} pages, {row[6] / 1e6:.1f} MB text, "
            f"fetched {row[4][:10]}..{row[5][:10]}")
    con.close()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["versions", "fetch", "index", "all", "status"])
    p.add_argument("--mirror-dir", default=os.environ.get("OMNIDEX_DOCS_MIRROR"),
                   help="default: <omnidex userData>/docs-mirror")
    p.add_argument("--sources", default=str(HERE / "sources.toml"))
    p.add_argument("--product", action="append", help="limit to a product (repeatable)")
    p.add_argument("--source", action="append", help="limit to a source name (repeatable)")
    p.add_argument("--refresh", action="store_true", help="re-check already mirrored sources")
    p.add_argument("--dry-run", action="store_true", help="list pages without writing")
    p.add_argument("--delay", type=float, default=1.0, help="seconds between requests per host")
    args = p.parse_args(argv)
    mirror = Path(args.mirror_dir) if args.mirror_dir else default_mirror_dir()
    log(f"Mirror: {mirror}")
    if args.command == "status":
        cmd_status(mirror)
        return 0
    installed = cmd_versions(mirror) if args.command in ("versions", "fetch", "all") else \
        json.loads((mirror / "versions.json").read_text(encoding="utf-8")) \
        if (mirror / "versions.json").is_file() else {}
    if args.command in ("fetch", "all"):
        cmd_fetch(args, mirror, installed)
    if args.command in ("index", "all") and not args.dry_run:
        build_index(mirror, installed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
