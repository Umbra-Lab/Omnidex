/**
 * Oracle docs tools: read-only access to the local vendor docs mirror (docs.db), built by
 * scripts/docs-mirror/docs_mirror.py.
 *
 * The point is whole-text reading with citations. Web fetch tools truncate or summarize
 * pages, so agents read a sliver and fill the rest from memory. These tools return full
 * sections in chunks (about 20,000 characters, broken at a line end) that say how much is
 * left, and `docs_verify` checks that a quoted passage is in the stored text without
 * spending model tokens. It proves the words are there, not that the agent read them right.
 *
 * docs.db is opened per call and closed again: the mirror can be built or rebuilt while the
 * server runs (on Windows an open handle would block the indexer's atomic replace).
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const READ_CHUNK = 20_000;
const MIN_CHUNK = 2_000;
const MAX_CHUNK = 40_000;

export const docsTools = [
  {
    name: 'docs_search',
    description:
      'Search the LOCAL mirror of official vendor docs (Blender, Houdini, Unity, Unreal, Godot, ' +
      'Substance, Cascadeur, ...) pinned to the installed versions. Returns sections with a ' +
      'citation (path#anchor@version), size and source URL. Snippets are previews only: read ' +
      'the section with docs_read before relying on it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or API names, e.g. "primitive_cube_add"' },
        product: { type: 'string', description: 'Optional product key, e.g. blender, unreal' },
        version: { type: 'string', description: 'Optional docs version, e.g. 5.3' },
        kind: { type: 'string', description: 'Optional: reference | guide | best-practice' },
        all_versions: {
          type: 'boolean',
          description: 'Also search docs for versions other than the installed one',
        },
        limit: { type: 'number', description: 'Max sections, default 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'docs_outline',
    description:
      'Heading tree of one mirrored page with the size of each section, so you can plan to read ' +
      'all of it. Accepts a path or a citation (path#anchor@version).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Page path from docs_search' } },
      required: ['path'],
    },
  },
  {
    name: 'docs_read',
    description:
      'Full text of a mirrored page or one section, never summarized. Long text comes in chunks: ' +
      'the header gives the percentage read, total_chars and next_offset. Keep calling with next_offset ' +
      'until has_more is false before concluding anything from the page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Page path or citation (path#anchor@version)' },
        section: {
          type: 'string',
          description:
            'Optional section anchor or index from docs_outline; omit for the whole page',
        },
        offset: { type: 'number', description: 'Character offset from next_offset, default 0' },
        max_chars: { type: 'number', description: `Chunk size, default ${READ_CHUNK}` },
      },
      required: ['path'],
    },
  },
  {
    name: 'docs_verify',
    description:
      'Check that a citation is real: the page exists and contains the quoted text ' +
      '(whitespace and markdown emphasis ignored). Run it on every quote you cite.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Citation path#anchor@version, or a page path' },
        quote: { type: 'string', description: 'Exact text you are citing' },
      },
      required: ['path', 'quote'],
    },
  },
  {
    name: 'docs_versions',
    description:
      'What the docs mirror holds: products, docs versions, page counts and fetch dates, the ' +
      'installed app versions, and any product whose mirror does not match the installed version.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const docsToolNames = new Set(docsTools.map((t) => t.name));

function notBuilt(docsDbPath) {
  return (
    `Docs mirror not built (no ${docsDbPath}). Build it with:\n` +
    '  python scripts/docs-mirror/docs_mirror.py all\n' +
    'Until then, say the answer is not in the local docs rather than guessing.'
  );
}

/** Split "path#anchor@version" into parts; a plain path passes through. */
export function parseCitation(raw) {
  const s = String(raw ?? '').trim();
  // Page paths can contain '@' (Godot's class_@gdscript.md), so '@version' and '#anchor'
  // only count after the '.md' that ends the path.
  const m = s.match(/^(.*?\.md)(?:#([^@]*))?(?:@([^@/#]+))?$/);
  if (!m) return { path: s, anchor: null, version: null };
  return { path: m[1], anchor: m[2] || null, version: m[3] || null };
}

function ftsQuote(query) {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(' ');
}

/**
 * Text as a reader sees it: links and images reduced to their text, emphasis markers and
 * inline-code backticks removed (but `*` inside code, as in `f(*args)`, kept), whitespace
 * collapsed.
 */
export function normalizeText(s) {
  return String(s)
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replaceAll(/`+([^`]*)`+/g, (_, code) => `\u0000${code.replaceAll('*', '\u0001')}\u0000`)
    .replaceAll(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replaceAll(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replaceAll('\u0000', '')
    .replaceAll('\u0001', '*')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

const MIN_QUOTE = 12;

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function getPage(db, path) {
  return db.prepare('SELECT * FROM pages WHERE path = ?').get(path);
}

function getSections(db, pageId) {
  return db.prepare('SELECT * FROM sections WHERE page_id = ? ORDER BY ord').all(pageId);
}

function findSection(sections, key) {
  if (key === null || key === undefined || key === '') return null;
  const k = String(key);
  // Anchors first: a heading "4.2" has the anchor "42", which must not be read as index 42.
  const byAnchor = sections.find((s) => s.anchor === k);
  if (byAnchor) return byAnchor;
  return /^\d+$/.test(k) ? (sections.find((s) => s.ord === Number(k)) ?? null) : null;
}

function citation(page, section) {
  return `${page.path}${section ? `#${section.anchor}` : ''}@${page.doc_version}`;
}

function installedDocVersions(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'installed'").get();
  const out = {};
  try {
    for (const [product, info] of Object.entries(JSON.parse(row?.value ?? '{}'))) {
      const parts = info?.version ? String(info.version).match(/\d+/g) : null;
      if (parts && parts.length >= 2) out[product] = `${parts[0]}.${parts[1]}`;
    }
  } catch {
    // An unreadable meta row means no pinning, never an error.
  }
  return out;
}

function search(db, args) {
  const terms = String(args.query ?? '')
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return 'Empty query.';
  const limit = Math.max(1, Math.min(Math.trunc(Number(args.limit) || 10), 50));
  // Unless a version is asked for, search only the docs for the installed version of each
  // product (plus unversioned "current" sets), so an old mirror never answers for a new app.
  const pinned =
    args.version || args.all_versions ? '{}' : JSON.stringify(installedDocVersions(db));
  const stmt = db.prepare(`
      SELECT p.path, p.doc_version, p.title, p.source_url, p.fetched_at, p.kind,
             s.heading, s.anchor, s.chars, s.ord,
             snippet(sections_fts, 2, '«', '»', ' … ', 24) AS snip
      FROM sections_fts f
      JOIN sections s ON s.id = f.rowid
      JOIN pages p ON p.id = s.page_id
      WHERE sections_fts MATCH ?
        AND (? IS NULL OR p.product = ?)
        AND (? IS NULL OR p.doc_version = ?)
        AND (? IS NULL OR p.kind = ?)
        AND (p.doc_version = 'current'
             OR json_extract(?, '$."' || p.product || '"') IS NULL
             OR json_extract(?, '$."' || p.product || '"') = p.doc_version)
      ORDER BY bm25(sections_fts, 8.0, 6.0, 1.0)
      LIMIT ?`);
  const run = (match) =>
    stmt.all(
      match,
      args.product ?? null,
      args.product ?? null,
      args.version ?? null,
      args.version ?? null,
      args.kind ?? null,
      args.kind ?? null,
      pinned,
      pinned,
      limit,
    );
  let rows = run(ftsQuote(terms.join(' ')));
  let note = '';
  if (rows.length === 0 && terms.length > 1) {
    // Every word must match first; a natural-language question rarely does, so retry with
    // any word and say so.
    rows = run(terms.map((t) => ftsQuote(t)).join(' OR '));
    note = 'No section has every word; these match some of them.\n';
  }
  if (rows.length === 0) {
    return 'No sections matched in the local docs. Do not fill the gap from memory; say so.';
  }
  const lines = rows.map((r) => {
    const where = r.heading && r.heading !== r.title ? `${r.title} › ${r.heading}` : r.title;
    return (
      `${r.path}#${r.anchor}@${r.doc_version} — ${where} (${fmt(r.chars)} chars, ${r.kind})\n` +
      `  ${r.source_url} · fetched ${String(r.fetched_at).slice(0, 10)}\n` +
      `  ${r.snip.replaceAll(/\s+/g, ' ')}`
    );
  });
  return `${note}${lines.join('\n')}\n\nRead a section in full with docs_read(path, section=anchor) before citing it.`;
}

function outline(db, args) {
  const { path } = parseCitation(args.path);
  const page = getPage(db, path);
  if (!page) return `No mirrored page at ${path}. Use docs_search to find paths.`;
  const sections = getSections(db, page.id);
  const head =
    `${page.title}\n${page.path}@${page.doc_version} · ${page.source_url} · ` +
    `fetched ${String(page.fetched_at).slice(0, 10)} · ${fmt(page.chars)} chars total`;
  const body = sections.map(
    (s) =>
      `[${s.ord}] ${'  '.repeat(Math.max(0, s.level - 1))}${s.heading || '(intro)'}  ` +
      `#${s.anchor}  ${fmt(s.chars)} chars`,
  );
  return `${head}\n${body.join('\n')}`;
}

function read(db, args) {
  const cite = parseCitation(args.path);
  const page = getPage(db, cite.path);
  if (!page) return `No mirrored page at ${cite.path}. Use docs_search to find paths.`;
  const sections = getSections(db, page.id);
  const sectionKey = args.section ?? cite.anchor;
  let text;
  let section = null;
  if (sectionKey !== null && sectionKey !== undefined && sectionKey !== '') {
    section = findSection(sections, sectionKey);
    if (!section) return `No section "${sectionKey}" on ${page.path}. Use docs_outline.`;
    text = section.body;
  } else {
    text = sections.map((s) => s.body).join('\n\n');
  }
  const size = Math.max(
    MIN_CHUNK,
    Math.min(Math.trunc(Number(args.max_chars) || READ_CHUNK), MAX_CHUNK),
  );
  const total = text.length;
  const offset = Math.max(0, Math.min(Math.trunc(Number(args.offset) || 0), total));
  let end = Math.min(offset + size, total);
  if (end < total) {
    // Prefer to break at a line end in the last tenth of the chunk.
    const nl = text.lastIndexOf('\n', end);
    if (nl > offset + size * 0.9) end = nl + 1;
  }
  const hasMore = end < total;
  const pct = total === 0 ? 100 : Math.round((end / total) * 100);
  const header = [
    `${page.title} — cite as ${citation(page, section)}`,
    `source: ${page.source_url} · fetched ${String(page.fetched_at).slice(0, 10)}` +
      (page.product_version ? ` · installed ${page.product_version}` : ''),
    `chars ${fmt(offset)}–${fmt(end)} of total_chars ${fmt(total)} (${pct}% read); ` +
      `has_more: ${hasMore}${hasMore ? `; next_offset: ${end}` : ''}`,
    '---',
  ];
  const footer = hasMore
    ? `\n---\nNOT FINISHED: call docs_read again with offset=${end} to read the rest.`
    : '';
  return `${header.join('\n')}\n${text.slice(offset, end)}${footer}`;
}

function verify(db, args) {
  const cite = parseCitation(args.path);
  const quote = normalizeText(args.quote ?? '');
  if (quote.length < MIN_QUOTE) {
    return `NOT VERIFIED: quote at least ${MIN_QUOTE} characters, so a match means something.`;
  }
  const page = getPage(db, cite.path);
  if (!page) return `NOT VERIFIED: no mirrored page at ${cite.path}.`;
  if (cite.version && cite.version !== page.doc_version) {
    return `NOT VERIFIED: the mirror holds ${page.path} for version ${page.doc_version}, not ${cite.version}.`;
  }
  const sections = getSections(db, page.id);
  const cited = cite.anchor ? findSection(sections, cite.anchor) : null;
  if (cite.anchor && !cited) return `NOT VERIFIED: ${page.path} has no section #${cite.anchor}.`;
  if (cited && normalizeText(cited.body).includes(quote)) {
    return `VERIFIED: ${citation(page, cited)} (${page.source_url})`;
  }
  const hit = sections.find((s) => normalizeText(s.body).includes(quote));
  const onPage = hit || normalizeText(sections.map((s) => s.body).join('\n\n')).includes(quote);
  if (!onPage) return `NOT VERIFIED: the quote does not appear on ${page.path}.`;
  if (cited) {
    const where = hit ? `#${hit.anchor}` : 'across a section boundary';
    return `PARTLY VERIFIED: the quote is on the page (${where}), not in #${cited.anchor}. Cite ${citation(page, hit ?? null)}.`;
  }
  return `VERIFIED: ${citation(page, hit ?? null)} (${page.source_url})`;
}

function versions(db) {
  const meta = Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((r) => [r.key, r.value]),
  );
  let installed = {};
  try {
    installed = JSON.parse(meta.installed ?? '{}');
  } catch {
    installed = {};
  }
  const rows = db
    .prepare(`
      SELECT product, doc_version, doc_set, COUNT(*) AS pages, MIN(fetched_at) AS first,
             MAX(fetched_at) AS last
      FROM pages GROUP BY product, doc_version, doc_set ORDER BY product, doc_version, doc_set`)
    .all();
  const lines = [`Index built ${meta.built_at ?? 'unknown'}`];
  for (const r of rows) {
    lines.push(
      `  ${r.product}/${r.doc_version}/${r.doc_set}: ${fmt(r.pages)} pages, fetched ` +
        `${String(r.first).slice(0, 10)}..${String(r.last).slice(0, 10)}`,
    );
  }
  lines.push('Installed:');
  const mirrored = new Set(rows.map((r) => `${r.product}/${r.doc_version}`));
  for (const [product, info] of Object.entries(installed).sort()) {
    const v = info?.version ?? null;
    const parts = v ? String(v).match(/\d+/g) : null;
    const docV = parts && parts.length >= 2 ? `${parts[0]}.${parts[1]}` : null;
    const versionedRows = rows.filter((r) => r.product === product && r.doc_version !== 'current');
    let note = '';
    if (docV && versionedRows.length > 0 && !mirrored.has(`${product}/${docV}`)) {
      note = `  ← MISMATCH: docs mirrored for ${[...new Set(versionedRows.map((r) => r.doc_version))].join(', ')}, run docs_mirror.py fetch`;
    } else if (!rows.some((r) => r.product === product)) {
      note = '  (no docs mirrored)';
    }
    lines.push(`  ${product}: ${v ?? 'version unknown'}${note}`);
  }
  return lines.join('\n');
}

/** Run a docs tool. Returns the text result. */
export function callDocsTool(name, args, docsDbPath) {
  if (!existsSync(docsDbPath)) return notBuilt(docsDbPath);
  const db = new DatabaseSync(docsDbPath, { readOnly: true });
  try {
    if (name === 'docs_search') return search(db, args);
    if (name === 'docs_outline') return outline(db, args);
    if (name === 'docs_read') return read(db, args);
    if (name === 'docs_verify') return verify(db, args);
    if (name === 'docs_versions') return versions(db);
    throw new Error(`Unknown docs tool: ${name}`);
  } finally {
    db.close();
  }
}
