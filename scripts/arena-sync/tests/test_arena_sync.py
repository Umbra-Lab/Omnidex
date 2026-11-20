"""Run: python -m unittest discover -s scripts/arena-sync/tests"""

import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class FakeArena:
    def __init__(self):
        self.blocks = [
            {"id": 1, "base_type": "Block", "type": "Image", "title": "Rim light study",
             "description": {"markdown": "Warm backlit figure."},
             "source": {"url": "https://example.com/rim", "title": "Example"},
             "image": {"src": "IMG/1/original.png", "content_type": "image/png",
                       "large": {"src": "IMG/1/large.png"}},
             "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"},
            {"id": 2, "base_type": "Block", "type": "Link", "title": "Inventory screen",
             "description": None, "source": {"url": "https://example.com/inv", "title": "Inv"},
             "created_at": "2026-01-02T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z"},
            {"id": 3, "base_type": "Channel", "title": "Nested channel"},
        ]
        self.requests = []
        self.auth = []


def make_handler(arena: FakeArena, base: list):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            parts = urlsplit(self.path)
            arena.requests.append(parts.path)
            arena.auth.append(self.headers.get("Authorization"))
            if parts.path.startswith("/IMG/"):
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.end_headers()
                self.wfile.write(PNG)
                return
            if parts.path == "/v3/channels/refs":
                return self.json({"id": 77, "slug": "refs", "title": "Refs"})
            if parts.path == "/v3/channels/77/contents":
                page = int(parse_qs(parts.query)["page"][0])
                data = [dict(b) for b in arena.blocks]
                for b in data:
                    if "image" in b:
                        b["image"] = json.loads(json.dumps(b["image"]).replace("IMG/", base[0] + "/IMG/"))
                chunk = data[(page - 1) * 2: page * 2]
                more = page * 2 < len(data)
                return self.json({"data": chunk, "meta": {"current_page": page, "has_more_pages": more,
                                                           "next_page": page + 1 if more else None}})
            self.send_response(404)
            self.end_headers()

        def json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-RateLimit-Remaining", "100")
            self.end_headers()
            self.wfile.write(body)

    return H


class ArenaSyncTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.arena = FakeArena()
        base = [""]
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.arena, base))
        base[0] = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.vault = Path(self.tmp.name) / "vault"
        self.config = Path(self.tmp.name) / "arena.toml"
        self.config.write_text(f"""
vault = "{self.vault.as_posix()}"
folder = "Refs"
[keywords]
lighting = ["backlit"]
ui = ["inventory"]
[[channel]]
slug = "refs"
themes = ["mood"]
""")
        env = {"ARENA_API": base[0] + "/v3", "ARENA_TOKEN": "tok"}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        sys.modules.pop("arena_sync", None)
        import arena_sync

        self.mod = arena_sync
        self.sleep = mock.patch.object(arena_sync.time, "sleep", lambda s: None)
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.env.stop()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def run_sync(self):
        self.assertEqual(self.mod.main(["--config", str(self.config)]), 0)

    def test_full_then_incremental_sync(self):
        self.run_sync()
        root = self.vault / "Refs"
        note1 = root / "refs" / "1-rim-light-study.md"
        note2 = root / "refs" / "2-inventory-screen.md"
        self.assertTrue(note1.is_file() and note2.is_file())
        self.assertFalse(any("nested" in p.name for p in (root / "refs").iterdir()))
        text = note1.read_text()
        self.assertIn('themes: ["mood", "lighting"]', text)
        self.assertIn('"theme/lighting"', text)
        self.assertIn("![[_images/1.png]]", text)
        self.assertEqual((root / "refs" / "_images" / "1.png").read_bytes(), PNG)
        self.assertIn("/IMG/1/large.png", self.arena.requests, "configured size is downloaded")
        self.assertIn('ui"', note2.read_text())
        self.assertIn("[[refs/1-rim-light-study|Rim light study]]", (root / "refs" / "_index.md").read_text())
        self.assertIn("Rim light study", (root / "Themes" / "lighting.md").read_text())
        self.assertEqual(self.arena.auth[0], "Bearer tok")
        self.assertIsNone(self.arena.auth[self.arena.requests.index("/IMG/1/large.png")],
                          "token is never sent to image hosts")

        # User notes survive an update; images are not downloaded twice; removals are flagged.
        note1.write_text(note1.read_text() + "My notes: use for the forge scene.\n")
        self.arena.blocks[0]["updated_at"] = "2026-02-01T00:00:00Z"
        self.arena.blocks[0]["title"] = "Rim light study v2"
        del self.arena.blocks[1]
        self.arena.requests.clear()
        self.run_sync()
        text = note1.read_text()
        self.assertIn("# Rim light study v2", text)
        self.assertIn("My notes: use for the forge scene.", text)
        self.assertNotIn("/IMG/1/large.png", self.arena.requests)
        self.assertIn("arena_removed: true", note2.read_text())
        self.assertNotIn("Inventory", (root / "refs" / "_index.md").read_text())

    def test_reset_seconds(self):
        import time

        self.assertEqual(self.mod._reset_seconds({"Retry-After": "12"}), 12.0)
        self.assertAlmostEqual(self.mod._reset_seconds({"X-RateLimit-Reset": str(time.time() + 30)}), 30, delta=2)
        self.assertIsNone(self.mod._reset_seconds({}))


if __name__ == "__main__":
    unittest.main()
