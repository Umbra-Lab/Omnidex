"""Run: python -m unittest discover -s scripts/docs-mirror/tests"""

import json
import os
import sqlite3
import sys
import tempfile
import threading
import unittest
from urllib.parse import urlsplit
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import docs_mirror  # noqa: E402
import html2md  # noqa: E402
import versions  # noqa: E402

PAGE = """<!doctype html><html><head><title>bpy.ops.mesh - Blender API</title></head><body>
<nav><a href="/api/5.3/other.html">Nav link</a> sidebar junk</nav>
<div role="main">
<h1>bpy.ops.mesh<a class="headerlink" href="#x">¶</a></h1>
<p>Use <code>bpy.ops.mesh.primitive_cube_add</code> to add a <strong>cube</strong>.
See <a href="other.html">the other page</a>.</p>
<h2>Arguments</h2>
<ul><li>size <em>(float)</em> – edge length<ul><li>default 2.0</li></ul></li><li>location</li></ul>
<pre class="highlight-python">import bpy
bpy.ops.mesh.primitive_cube_add(size=2)</pre>
<table><tr><th>Name</th><th>Type</th></tr><tr><td>size</td><td>float</td></tr></table>
<h2>Gotchas</h2><p>Operators need the right <code>context</code>.</p>
</div><footer>Copyright</footer></body></html>"""

OTHER = """<html><body><div role="main"><h1>Other page</h1>
<p>Linked from index. Text long enough to count as content for the mirror.</p>
<a href="../outside/page.html">out of scope</a></div></body></html>"""


class Html2MdTest(unittest.TestCase):
    def test_extracts_main_region_and_structure(self):
        title, md = html2md.extract(PAGE, "https://docs.example/api/5.3/index.html", ["[role=main]"])
        self.assertEqual(title, "bpy.ops.mesh")
        self.assertNotIn("sidebar junk", md)
        self.assertNotIn("Copyright", md)
        self.assertNotIn("¶", md)
        self.assertIn("# bpy.ops.mesh", md)
        self.assertIn("`bpy.ops.mesh.primitive_cube_add`", md)
        self.assertIn("[the other page](https://docs.example/api/5.3/other.html)", md)
        self.assertIn("- size *(float)* – edge length\n    - default 2.0", md)
        self.assertIn("```python\nimport bpy\nbpy.ops.mesh.primitive_cube_add(size=2)\n```", md)
        self.assertIn("| Name | Type |\n| --- | --- |\n| size | float |", md)

    def test_review_regressions(self):
        html = """<html><body><article><header><h1>Title kept</h1></header>
        <p>Intro</p><aside class="footnote"><p>Footnote kept</p></aside>
        <div class="tab" hidden><pre>var csharp = 1;</pre></div>
        <ul><li>one<li>two</ul>
        <table><tr><td><p>para one</p><p>para two</p></td><td>x</td></tr></table>
        </article></body></html>"""
        title, md = html2md.extract(html, "https://d/x.html")
        self.assertEqual(title, "Title kept")
        self.assertIn("Footnote kept", md)
        self.assertIn("var csharp = 1;", md, "hidden tab panels are content")
        self.assertIn("- one\n- two", md)
        self.assertIn("| para one<br>para two | x |", md)
        # Chrome is dropped only when the whole body is converted.
        _, body_md = html2md.extract("<body><header>Site</header><p>Body text</p></body>", "https://d/")
        self.assertNotIn("Site", body_md)

    def test_links_resolve_and_drop_fragments(self):
        links = html2md.links(PAGE, "https://docs.example/api/5.3/index.html")
        self.assertIn("https://docs.example/api/5.3/other.html", links)
        self.assertNotIn("https://docs.example/api/5.3/index.html#x", links)


class SectionsTest(unittest.TestCase):
    def test_split_ignores_headings_in_code(self):
        md = "intro\n\n# A\ntext\n```\n# not a heading\n```\n## B\nmore\n## B\nagain"
        secs = docs_mirror.split_sections(md)
        self.assertEqual([s["heading"] for s in secs], ["", "A", "B", "B"])
        self.assertEqual([s["anchor"] for s in secs], ["top", "a", "b", "b-1"])
        self.assertIn("# not a heading", secs[1]["body"])

    def test_long_fence_is_not_closed_by_short_one(self):
        md = "# A\n````\n```\n# comment, not a heading\n```\n````\n## B\nx"
        self.assertEqual([x["heading"] for x in docs_mirror.split_sections(md)], ["A", "B"])

    def test_symbols(self):
        syms = docs_mirror.symbols("call hou.Node.createNode and primitive_cube_add, not plain words")
        for s in ("hou.Node.createNode", "createNode", "primitive_cube_add"):
            self.assertIn(s, syms.split())
        self.assertNotIn("plain", syms.split())

    def test_relpath(self):
        rp = docs_mirror.url_to_relpath
        self.assertEqual(rp("https://d/api/5.3/bpy.ops.html", ["https://d/api/5.3/"]), "bpy.ops.md")
        self.assertEqual(rp("https://d/api/5.3/", ["https://d/api/5.3/"]), "index.md")
        self.assertEqual(
            rp("https://e/docs/py/?application_version=5.8", ["https://e/docs/py/"]), "index.md")
        self.assertEqual(
            rp("https://e/docs/py/x?application_version=5.8&lang=en", ["https://e/docs/py/"]),
            "x__lang_en.md")
        # Fixed page lists have no prefix: host and path keep pages apart.
        self.assertEqual(rp("https://h/a/one.html", []), "h/a/one.md")
        self.assertNotEqual(rp("https://h/a/one.html", []), rp("https://h/b/two.html", []))
        self.assertEqual(rp("https://h/api/con.html", ["https://h/api/"]), "_con.md")

    def test_normalize_scope_and_pinning(self):
        n = docs_mirror.normalize
        self.assertEqual(n("https://h/api/5.3/%2e%2e/%2e%2e/evil.html"), "https://h/evil.html")
        self.assertFalse(docs_mirror.in_scope(n("https://h/api/5.3/%2e%2e/x.html"), ["https://h/api/5.3/"]))
        self.assertFalse(docs_mirror.in_scope("https://h/api/5.3/_images/a.png", ["https://h/api/5.3/"]))
        pin = "application_version=5.8"
        self.assertEqual(n("https://e/py/x", pin), "https://e/py/x?application_version=5.8")
        self.assertEqual(n("https://e/py/x?application_version=5.5&a=1", pin),
                         "https://e/py/x?a=1&application_version=5.8")


class VersionsTest(unittest.TestCase):
    def test_doc_version(self):
        self.assertEqual(versions.doc_version("5.3.1"), "5.3")
        self.assertEqual(versions.doc_version("6000.3.2f1"), "6000.3")
        self.assertEqual(versions.doc_version("22.0.512"), "22.0")
        self.assertIsNone(versions.doc_version(None))

    def test_detects_highest_version_and_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            pf = Path(tmp) / "pf"
            for d in ("Blender Foundation/Blender 5.2", "Blender Foundation/Blender 5.3",
                      "Side Effects Software/Houdini 22.0.512", "Unity/Hub/Editor/6000.3.2f1",
                      "Epic Games/UE_5.8", "Rizom Lab/RizomUV 2027.0"):
                (pf / d).mkdir(parents=True)
            mirror = Path(tmp) / "mirror"
            mirror.mkdir()
            (mirror / "versions.override.toml").write_text('[versions]\ngodot = "4.7"\n')
            env = {"ProgramFiles": str(pf)}
            with unittest.mock.patch.dict("os.environ", env, clear=True):
                found = versions.load(mirror, home=Path(tmp))
            self.assertEqual(found["blender"]["version"], "5.3")
            self.assertEqual(found["houdini"]["version"], "22.0.512")
            self.assertEqual(found["unity"]["version"], "6000.3.2f1")
            self.assertEqual(found["unreal"]["version"], "5.8")
            self.assertEqual(found["rizomuv"]["version"], "2027.0")
            self.assertEqual(found["godot"], {"version": "4.7", "path": "", "source": "override"})


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class CrawlAndIndexTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name) / "site"
        (root / "api" / "5.3").mkdir(parents=True)
        (root / "api" / "5.3" / "index.html").write_text(PAGE, encoding="utf-8")
        (root / "api" / "5.3" / "other.html").write_text(OTHER, encoding="utf-8")
        (root / "api" / "5.3" / "secret.html").write_text(OTHER, encoding="utf-8")
        (root / "robots.txt").write_text("User-agent: *\nDisallow: /api/5.3/secret.html\n")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(root)))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.mirror = Path(self.tmp.name) / "mirror"
        sources = Path(self.tmp.name) / "sources.toml"
        sources.write_text(f"""
[[source]]
product = "blender"
name = "python-api"
start = ["{self.base}/api/{{version}}/index.html", "{self.base}/api/{{version}}/secret.html"]
prefix = ["{self.base}/api/{{version}}/"]
selectors = ["[role=main]"]
""")
        self.sources = sources
        self.mirror.mkdir()
        (self.mirror / "versions.override.toml").write_text('[versions]\nblender = "5.3.1"\n')

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def run_cli(self, *extra):
        with unittest.mock.patch.dict("os.environ", {"ProgramFiles": self.tmp.name + "/none"}):
            docs_mirror.main(["all", "--mirror-dir", str(self.mirror), "--sources", str(self.sources),
                              "--delay", "0", *extra])

    def test_crawl_respects_scope_and_robots_then_indexes(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        self.assertTrue((root / "index.md").is_file())
        self.assertTrue((root / "other.md").is_file())
        self.assertFalse((root / "secret.md").exists(), "robots.txt must be honoured")
        meta, body = docs_mirror.read_page(root / "index.md")
        self.assertEqual(meta["doc_version"], "5.3")
        self.assertEqual(meta["product_version"], "5.3.1")
        self.assertTrue(meta["source_url"].endswith("/api/5.3/index.html"))
        self.assertIn("CHANGES.md", [p.name for p in root.iterdir()])

        con = sqlite3.connect(self.mirror / "docs.db")
        hits = con.execute(
            "SELECT s.heading FROM sections_fts f JOIN sections s ON s.id = f.rowid "
            "WHERE sections_fts MATCH ? ORDER BY rank", ('"primitive_cube_add"',)).fetchall()
        self.assertTrue(hits, "identifier with underscores must be searchable whole")
        installed = json.loads(con.execute("SELECT value FROM meta WHERE key='installed'").fetchone()[0])
        self.assertEqual(installed["blender"]["version"], "5.3.1")
        # Section offsets let a reader page through the original text.
        page_chars, = con.execute("SELECT chars FROM pages WHERE path LIKE '%index.md'").fetchone()
        last = con.execute("SELECT start_char + chars FROM sections ORDER BY id DESC LIMIT 1").fetchone()[0]
        self.assertLessEqual(last, page_chars)
        con.close()

    def test_refresh_never_deletes_after_failures(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        site = Path(self.tmp.name) / "site" / "api" / "5.3"
        (site / "other.html").unlink()
        self.run_cli("--refresh")
        self.assertFalse((root / "other.md").exists(), "an explicit 404 removes that page")
        self.assertTrue((root / "index.md").is_file())

        self.run_cli()
        (site / "index.html").unlink()  # start page gone: the docs moved, not all removed
        self.run_cli("--refresh")
        self.assertTrue((root / "index.md").is_file(), "a missing start page removes nothing")
        self.run_cli("--refresh", "--prune")
        self.assertFalse((root / "index.md").exists(), "--prune lets the removal through")

    def test_refresh_keeps_mirror_when_start_page_is_a_shell(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        index = Path(self.tmp.name) / "site" / "api" / "5.3" / "index.html"
        index.write_text("<html><body><p>Just a moment...</p></body></html>", encoding="utf-8")
        later = index.stat().st_mtime + 10
        os.utime(index, (later, later))
        self.run_cli("--refresh")
        self.assertIn("primitive_cube_add", (root / "index.md").read_text(), "shell not saved")
        self.assertTrue((root / "other.md").is_file(), "pages it used to link to are kept")

    def test_hub_page_losing_all_links_is_not_trusted(self):
        broken = docs_mirror._looks_broken
        prev = {"chars": 2000, "links": ["a", "b", "c"]}
        self.assertTrue(broken({"md": "x" * 1500, "links": []}, prev, Path("/nonexistent")))
        self.assertFalse(broken({"md": "x" * 1500, "links": ["a"]}, prev, Path("/nonexistent")))

    def test_capped_refresh_finishes_on_the_next_run(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        other = Path(self.tmp.name) / "site" / "api" / "5.3" / "other.html"
        other.write_text(OTHER.replace("</div>", "<p>Edited later.</p></div>"), encoding="utf-8")
        later = other.stat().st_mtime + 10
        os.utime(other, (later, later))
        capped = self.sources.read_text().replace('selectors = ["[role=main]"]',
                                                  'selectors = ["[role=main]"]\nmax_pages = 1')
        self.sources.write_text(capped)
        self.run_cli("--refresh")  # checks index only, then stops at the cap
        self.assertNotIn("Edited later", (root / "other.md").read_text())
        self.run_cli()  # resumes: other.md was not checked in that run, so it is fetched
        self.assertIn("Edited later", (root / "other.md").read_text())

    def test_unreadable_robots_removes_nothing(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        (Path(self.tmp.name) / "site" / "robots.txt").unlink()
        (Path(self.tmp.name) / "site" / "robots.txt").mkdir()  # directory: the server errors
        # A start URL the manifest has never seen, as after editing sources.toml.
        self.sources.write_text(self.sources.read_text().replace("index.html", "index.html?x=1"))
        with unittest.mock.patch.object(docs_mirror.Fetcher, "allowed",
                                        lambda self, url: (self.unreadable.add(
                                            "http://" + urlsplit(url).netloc), False)[1]):
            self.run_cli("--refresh")
        self.assertTrue((root / "index.md").is_file())
        self.assertTrue((root / "other.md").is_file())

    def test_case_only_paths_do_not_overwrite(self):
        used = {}
        a = docs_mirror._unique_rel("hou/Node.md", "https://h/hou/Node.html", used)
        used[a.casefold()] = "https://h/hou/Node.html"
        b = docs_mirror._unique_rel("hou/node.md", "https://h/hou/node.html", used)
        self.assertEqual(a, "hou/Node.md")
        self.assertNotEqual(a.casefold(), b.casefold())
        self.assertNotEqual(docs_mirror._unique_rel("changes.md", "https://h/changes.html", {}),
                            "changes.md")

    def test_duplicate_heading_anchors_are_unique(self):
        secs = docs_mirror.split_sections("## Foo\n\na\n\n## Foo\n\nb\n\n## Foo 1\n\nc\n")
        anchors = [s["anchor"] for s in secs]
        self.assertEqual(len(anchors), len(set(anchors)), anchors)

    def test_redirect_to_other_version_or_login_is_out_of_scope(self):
        away = docs_mirror._redirected_away
        pin = "application_version=5.8"
        self.assertTrue(away("https://e/py/x?application_version=5.8",
                             "https://e/py/x?application_version=5.7", ["https://e/py/"], pin))
        self.assertTrue(away("https://e/py/x?application_version=5.8", "https://e/py/x",
                             ["https://e/py/"], pin), "a dropped pin is the default version")
        self.assertTrue(away("https://h/docs/page.html", "https://h/login", [], None))
        self.assertFalse(away("https://h/docs/page", "https://h/docs/page/", [], None))

    def test_binary_links_are_not_saved(self):
        site = Path(self.tmp.name) / "site" / "api" / "5.3"
        (site / "pic.png").write_bytes(b"\x89PNG" + bytes(100))
        (site / "data").write_bytes(b"\x00\x01binary")  # no extension: caught by Content-Type
        (site / "other.html").write_text(OTHER.replace("</div>", '<a href="pic.png">p</a>'
                                                       '<a href="data">d</a></div>'), encoding="utf-8")
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        self.assertEqual(sorted(p.name for p in root.glob("*.md") if p.name != "CHANGES.md"),
                         ["index.md", "other.md"])

    def test_second_run_skips_and_refresh_detects_removal(self):
        self.run_cli()
        root = self.mirror / "docs" / "blender" / "5.3" / "python-api"
        index = Path(self.tmp.name) / "site" / "api" / "5.3" / "index.html"
        index.write_text(PAGE.replace('<a href="other.html">the other page</a>', "no link")
                         .replace('<a href="/api/5.3/other.html">Nav link</a>', ""),
                         encoding="utf-8")
        # Last-Modified has one-second resolution: move the mtime on so the edit is visible.
        later = index.stat().st_mtime + 10
        os.utime(index, (later, later))
        self.run_cli()  # no --refresh: untouched
        self.assertTrue((root / "other.md").is_file())
        (index.parent / "other.html").unlink()
        self.run_cli("--refresh")
        self.assertFalse((root / "other.md").exists(), "page gone from the site is removed")
        self.assertIn("Removed (1)", (root / "CHANGES.md").read_text())


import unittest.mock  # noqa: E402

if __name__ == "__main__":
    unittest.main()
