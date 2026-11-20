"""Dependency-free HTML -> Markdown for vendor documentation pages.

Documentation HTML is regular (Sphinx, Furo, Read the Docs, vendor portals), so a small
html.parser converter covers what agents need: headings, paragraphs, code blocks, inline
code, lists, tables, links and images. It never summarizes: every text node in the selected
content region is kept, except inside scripts, styles, forms and navigation.

Content selection: `extract(html, selectors)` keeps the first element matching a selector,
else falls back to <main>, <article>, [role=main], then <body>. Scripts, styles, forms and
<nav> are always dropped; <header>, <footer> and <aside> only when no content region was
found and the whole <body> is converted (inside a region they hold titles and footnotes).
"""

from __future__ import annotations

import re
from html.parser import HTMLParser
from urllib.parse import urljoin

DROP_TAGS = {"script", "style", "noscript", "nav", "form", "button", "svg", "template",
             "iframe", "select", "input", "label"}
CHROME_TAGS = {"header", "footer", "aside"}
# HTML lets some end tags be omitted. A new <li> closes an open <li> of the same list, and so
# on: tag -> (open tags it closes, tags that bound the search).
IMPLICIT_CLOSE = {
    "li": ({"li"}, {"ul", "ol", "menu"}),
    "dt": ({"dt", "dd"}, {"dl"}),
    "dd": ({"dt", "dd"}, {"dl"}),
    "td": ({"td", "th"}, {"tr", "table"}),
    "th": ({"td", "th"}, {"tr", "table"}),
    "tr": ({"tr"}, {"table", "tbody", "thead", "tfoot"}),
    "tbody": ({"tr", "tbody", "thead", "tfoot"}, {"table"}),
    "thead": ({"tr", "tbody", "thead", "tfoot"}, {"table"}),
    "tfoot": ({"tr", "tbody", "thead", "tfoot"}, {"table"}),
}
P_CLOSERS = {"div", "ul", "ol", "table", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
             "section", "article", "dl", "figure", "hr"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
             "param", "source", "track", "wbr"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "dl", "dt", "dd", "blockquote",
              "figure", "figcaption", "details", "summary", "center"}
# Classes that Sphinx and similar themes use for chrome inside the content region.
DROP_CLASSES = {"headerlink", "sphinxsidebar", "related", "breadcrumbs", "wy-breadcrumbs",
                "rst-footer-buttons", "toc-drawer", "prev-next-area", "footer", "navigation",
                "admonition-title-icon", "copybtn", "skip-link"}

DEFAULT_SELECTORS = ["main", "article", "[role=main]", "#content", ".body", "body"]


def _parse_selector(sel: str):
    """Supports `tag`, `#id`, `.class`, `[attr=value]` and `tag[attr=value]` / `tag.class`."""
    sel = sel.strip()
    m = re.fullmatch(r"([a-zA-Z0-9]*)(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)=\"?([^\]\"]+)\"?\])?", sel)
    if not m:
        raise ValueError(f"unsupported selector: {sel}")
    tag, ident, cls, attr, val = m.groups()
    return (tag.lower() or None, ident, cls, attr, val)


def _matches(parsed, tag: str, attrs: dict) -> bool:
    ptag, ident, cls, attr, val = parsed
    if ptag and ptag != tag:
        return False
    if ident and attrs.get("id") != ident:
        return False
    if cls and cls not in (attrs.get("class") or "").split():
        return False
    if attr and attrs.get(attr) != val:
        return False
    return True


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs, parent):
        self.tag = tag
        self.attrs = attrs
        self.children = []
        self.parent = parent


class _TreeBuilder(HTMLParser):
    """Builds a light DOM so content selection and conversion are separate passes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {}, None)
        self.cur = self.root
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "title":
            self._in_title = True
        # Omitted end tags (<li>a<li>b, <p>a<div>): close them here.
        if self.cur.tag == "p" and (tag == "p" or tag in P_CLOSERS or tag in IMPLICIT_CLOSE):
            self.cur = self.cur.parent
        if tag in IMPLICIT_CLOSE:
            closes, bounds = IMPLICIT_CLOSE[tag]
            n = self.cur
            while n is not self.root and n.tag not in bounds:
                if n.tag in closes:
                    self.cur = n.parent
                    break
                n = n.parent
        node = _Node(tag, {k: (v or "") for k, v in attrs}, self.cur)
        self.cur.children.append(node)
        if tag not in VOID_TAGS:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        node = _Node(tag.lower(), {k: (v or "") for k, v in attrs}, self.cur)
        self.cur.children.append(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        self.cur.children.append(data)


def _find(node, parsed):
    stack = [node]
    while stack:
        n = stack.pop(0)
        if isinstance(n, str):
            continue
        if n.tag != "#root" and _matches(parsed, n.tag, n.attrs):
            return n
        stack[0:0] = [c for c in n.children if not isinstance(c, str)]
    return None


def _text(node) -> str:
    if isinstance(node, str):
        return node
    return "".join(_text(c) for c in node.children)


def _dropped(node, chrome: bool = False) -> bool:
    if node.tag in DROP_TAGS or (chrome and node.tag in CHROME_TAGS):
        return True
    classes = set((node.attrs.get("class") or "").split())
    if classes & DROP_CLASSES:
        return True
    # `hidden` is not a reason to drop: tabbed code samples (C# beside GDScript) hide every
    # tab but the first. aria-hidden marks decoration such as icons and anchors.
    return node.attrs.get("aria-hidden") == "true"


class _Converter:
    def __init__(self, base_url: str, drop_chrome: bool = False):
        self.base = base_url
        self.chrome = drop_chrome

    def dropped(self, node) -> bool:
        return _dropped(node, self.chrome)

    def convert(self, node) -> str:
        out = self.block(node)
        out = re.sub(r"\n{3,}", "\n\n", out)
        return out.strip() + "\n"

    # Block context: returns markdown with blank lines between blocks.
    def block(self, node) -> str:
        parts = []
        inline_buf = []

        def flush():
            text = _squash("".join(inline_buf))
            if text.strip():
                parts.append(text.strip())
            inline_buf.clear()

        for c in node.children:
            if isinstance(c, str):
                inline_buf.append(c)
                continue
            if self.dropped(c):
                continue
            t = c.tag
            if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
                flush()
                text = _squash(self.inline(c)).strip()
                if text:
                    parts.append("#" * int(t[1]) + " " + text)
            elif t == "pre":
                flush()
                lang = _code_lang(c)
                code = _text(c).strip("\n")
                fence = "````" if "```" in code else "```"
                parts.append(f"{fence}{lang}\n{code}\n{fence}")
            elif t in ("ul", "ol"):
                flush()
                parts.append(self.list_(c, 0))
            elif t == "table":
                flush()
                parts.append(self.table(c))
            elif t == "hr":
                flush()
                parts.append("---")
            elif t == "dt":
                flush()
                text = _squash(self.inline(c)).strip()
                if text:
                    parts.append(f"**{text}**" if not text.startswith("`") else text)
            elif t == "blockquote":
                flush()
                inner = self.block(c).strip()
                if inner:
                    parts.append("\n".join("> " + ln if ln else ">" for ln in inner.split("\n")))
            elif t in BLOCK_TAGS or _has_block_child(c):
                flush()
                inner = self.block(c).strip()
                if inner:
                    parts.append(inner)
            else:
                inline_buf.append(self.inline(c))
        flush()
        return "\n\n".join(parts)

    def inline(self, node) -> str:
        if isinstance(node, str):
            return node
        if self.dropped(node):
            return ""
        t = node.tag
        if t == "br":
            return "  \n"
        if t == "img":
            src = node.attrs.get("src")
            if not src:
                return ""
            alt = node.attrs.get("alt", "").replace("]", "")
            return f"![{alt}]({urljoin(self.base, src)})"
        inner = "".join(self.inline(c) for c in node.children)
        if t in ("code", "kbd", "samp", "tt"):
            code = _squash(_text(node)).strip()
            if not code:
                return ""
            tick = "``" if "`" in code else "`"
            return f"{tick}{code}{tick}"
        if t in ("strong", "b"):
            s = inner.strip()
            return f"**{s}**" if s else ""
        if t in ("em", "i"):
            s = inner.strip()
            return f"*{s}*" if s else ""
        if t == "a":
            href = node.attrs.get("href", "")
            text = _squash(inner).strip()
            if not text:
                return ""
            if not href or href.startswith("javascript:"):
                return text
            return f"[{text}]({urljoin(self.base, href)})"
        return inner

    def list_(self, node, depth: int) -> str:
        lines = []
        ordered = node.tag == "ol"
        n = 0
        for li in node.children:
            if isinstance(li, str) or li.tag != "li":
                continue
            n += 1
            marker = f"{n}." if ordered else "-"
            pad = "    " * depth
            head, subs = [], []
            for c in li.children:
                if not isinstance(c, str) and c.tag in ("ul", "ol"):
                    subs.append(self.list_(c, depth + 1))
                elif not isinstance(c, str) and c.tag == "pre":
                    code = _text(c).strip("\n")
                    subs.append("\n".join(pad + "    " + ln for ln in ["```", *code.split("\n"), "```"]))
                elif not isinstance(c, str) and (c.tag in BLOCK_TAGS or _has_block_child(c)):
                    head.append(" " + self.block(c).replace("\n\n", " ") + " ")
                else:
                    head.append(self.inline(c))
            text = _squash("".join(head)).strip()
            lines.append(f"{pad}{marker} {text}".rstrip())
            lines.extend(subs)
        return "\n".join(lines)

    def cell(self, td) -> str:
        """One table cell on one line: block children are joined with <br>, so paragraphs
        and code lines stay apart instead of running together."""
        if _has_block_child(td):
            text = self.block(td).strip()
            text = re.sub(r"```[\w+#-]*\n?", "", text)
            text = text.replace("\n\n", "<br>").replace("\n", "<br>")
        else:
            text = _squash(self.inline(td)).strip().replace("  \n", "<br>")
        return text.replace("|", "\\|")

    def table(self, node) -> str:
        rows = []

        def walk(n):
            for c in n.children:
                if isinstance(c, str) or self.dropped(c):
                    continue
                if c.tag == "tr":
                    cells = [self.cell(td) for td in c.children
                             if not isinstance(td, str) and td.tag in ("td", "th")]
                    if cells:
                        rows.append(cells)
                elif c.tag in ("thead", "tbody", "tfoot"):
                    walk(c)

        walk(node)
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        out = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
        out += ["| " + " | ".join(r) + " |" for r in rows[1:]]
        return "\n".join(out)


def _has_block_child(node) -> bool:
    for c in node.children:
        if not isinstance(c, str) and (c.tag in BLOCK_TAGS or c.tag in ("pre", "ul", "ol", "table")
                                       or c.tag.startswith("h") and c.tag[1:].isdigit()):
            return True
    return False


def _code_lang(pre) -> str:
    n = pre
    while n is not None and n.tag != "#root":
        for cls in (n.attrs.get("class") or "").split():
            m = re.match(r"(?:highlight|language|lang)-([\w+#-]+)", cls)
            if m and m.group(1) not in ("default", "none", "text"):
                return m.group(1)
        n = n.parent
    for c in pre.children:
        if not isinstance(c, str) and c.tag == "code":
            for cls in (c.attrs.get("class") or "").split():
                m = re.match(r"(?:language|lang)-([\w+#-]+)", cls)
                if m:
                    return m.group(1)
    return ""


def _squash(s: str) -> str:
    # Collapse HTML whitespace but keep explicit markdown line breaks ("  \n").
    s = s.replace("  \n", "\x00")
    s = re.sub(r"[ \t\r\n\f\v]+", " ", s)
    return s.replace("\x00", "  \n")


def extract(html: str, url: str, selectors: list[str] | None = None) -> tuple[str, str]:
    """Return (title, markdown) for the documentation content of one page."""
    tb = _TreeBuilder()
    tb.feed(html)
    tb.close()
    node = None
    for sel in (selectors or []) + DEFAULT_SELECTORS:
        node = _find(tb.root, _parse_selector(sel))
        if node is not None:
            break
    if node is None:
        node = tb.root
    md = _Converter(url, drop_chrome=node.tag in ("body", "#root")).convert(node)
    title = _squash(tb.title).strip()
    first_h1 = re.search(r"^# (.+)$", md, re.M)
    if first_h1:
        title = first_h1.group(1).strip()
    return title, md


def links(html: str, url: str) -> list[str]:
    """Every href on the page, resolved against `url`, fragment stripped."""
    out = []

    class P(HTMLParser):
        def handle_starttag(self, tag, attrs):
            if tag.lower() == "a":
                href = dict(attrs).get("href")
                if href and not href.startswith(("mailto:", "javascript:", "#")):
                    out.append(urljoin(url, href).split("#", 1)[0])

    P().feed(html)
    return out
