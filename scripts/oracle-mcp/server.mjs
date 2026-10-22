#!/usr/bin/env node
/**
 * Omnidex Oracle MCP server v0 — read-only transcript search over the library DB.
 *
 * Zero dependencies: node:sqlite (Node >= 24) plus newline-delimited JSON-RPC over stdio,
 * which is the MCP stdio transport. Register with Claude Code:
 *
 *   claude mcp add omnidex-oracle -- node <repo>/scripts/oracle-mcp/server.mjs
 *
 * DB resolution: ORACLE_DB env var, else %APPDATA%/omnidex/omnidex.db. The DB is opened
 * read-only; the running app and this server share it safely under WAL (asserted below).
 */
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const PROTOCOL_VERSION = '2025-06-18';

const dbPath = process.env.ORACLE_DB ?? join(process.env.APPDATA ?? '.', 'omnidex', 'omnidex.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const journalMode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
if (journalMode !== 'wal') {
  // stderr is out-of-band for MCP stdio; stdout stays protocol-only.
  console.error(
    `omnidex-oracle: DB journal_mode=${journalMode}; long reads may block the app's writes`,
  );
}

function stamp(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// Quote every token so user input is a literal-term FTS query, never FTS5 syntax.
function ftsQuote(query) {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(' ');
}

// Make % and _ literal inside LIKE filters (paired with ESCAPE '\' in the SQL).
function likeEscape(s) {
  return s.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
}

function asFinite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Cues key on the subtitle file; the video is the same path minus the sub extension
// (`lesson.mp4.srt`, `lesson.srt`, and `lesson.en_US.vtt` conventions all exist).
function videoHint(subPath) {
  return subPath.replace(/(\.[a-z]{2}(_[A-Z]{2})?)?\.(srt|vtt)$/i, '');
}

const searchStmt = db.prepare(`
  SELECT q.text, q.file_id, q.start_ms, c.rel_path, c.abs_path, a.name AS course
  FROM transcript_fts t
  JOIN transcript_cues q ON q.id = t.rowid
  JOIN course_files c ON c.id = q.file_id
  JOIN assets a ON a.id = c.asset_id
  WHERE transcript_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`);
const searchInCourseStmt = db.prepare(`
  SELECT q.text, q.file_id, q.start_ms, c.rel_path, c.abs_path, a.name AS course
  FROM transcript_fts t
  JOIN transcript_cues q ON q.id = t.rowid
  JOIN course_files c ON c.id = q.file_id
  JOIN assets a ON a.id = c.asset_id
  WHERE transcript_fts MATCH ? AND a.name LIKE '%' || ? || '%' ESCAPE '\\'
  ORDER BY rank
  LIMIT ?
`);
// Was a full scan of the corpus per call (~1.1 s at 4.6M cues) when file_id was an
// UNINDEXED FTS5 column. transcript_cues is indexed on (file_id, start_ms).
const contextStmt = db.prepare(`
  SELECT text, start_ms FROM transcript_cues
  WHERE file_id = ? AND start_ms BETWEEN ? AND ?
  ORDER BY start_ms
`);
/**
 * Lesson-title search — the index transcripts cannot replace.
 *
 * Instructors do not say their own lesson titles out loud, so a cue search for
 * "outline effect theory" returns nothing while a whole 16-lesson module by
 * that name sits in the library. Titles are also complete: they exist for every
 * video, including the ~1% with no transcript and anything added before ASR
 * catches up. Transcripts and titles fail in opposite directions, which is
 * exactly why both are worth having.
 *
 * Terms are ANDed as substrings against the path, so "niagara ribbon" matches a
 * lesson whose folder says Niagara and whose filename says ribbon.
 */
const lessonsStmt = db.prepare(`
  SELECT c.rel_path, c.abs_path, c.duration_seconds, c.chapter,
         COALESCE(a.display_title, a.name) AS course
  FROM course_files c
  JOIN assets a ON a.id = c.asset_id
  WHERE c.kind = 'video' AND lower(c.rel_path) LIKE ? ESCAPE '\\'
  ORDER BY a.name, c.chapter, c.order_index, c.rel_path
  LIMIT ?
`);

/**
 * Asset search over the pack library — the half of Omnidex the oracle was blind
 * to. 2,799 packs with names, categories, ecosystems and marketplace metadata,
 * and no way to ask "do I already own something for this?" until now.
 *
 * Uses the existing `assets_fts` index (BM25, name weighted 10x) rather than a
 * LIKE scan, so ranking matches what the app's own search box returns.
 */
const assetsStmt = db.prepare(`
  SELECT a.name, a.orbital_title, a.file_path, a.file_size,
         a.orbital_categories, a.orbital_seller_name,
         COALESCE(a.asset_ecosystem, a.ecosystem, 'unknown') AS ecosystem
  FROM assets a
  JOIN assets_fts f ON f.rowid = a.id
  WHERE assets_fts MATCH ?
    AND a.content_format IS NULL
    AND a.missing_since IS NULL
  ORDER BY rank
  LIMIT ?
`);

const coursesStmt = db.prepare(`
  SELECT a.name,
    SUM(CASE WHEN c.kind = 'video' THEN 1 ELSE 0 END) AS videos,
    ROUND(SUM(CASE WHEN c.kind = 'video' THEN COALESCE(c.duration_seconds, 0) END) / 3600.0, 1)
      AS hours,
    SUM(CASE WHEN c.kind = 'subtitle' THEN 1 ELSE 0 END) AS subs
  FROM assets a
  JOIN course_files c ON c.asset_id = a.id
  WHERE a.name LIKE '%' || ? || '%' ESCAPE '\\'
  GROUP BY a.id
  HAVING videos > 0
  ORDER BY a.name
`);

const tools = [
  {
    name: 'search_transcripts',
    description:
      'Full-text search over every indexed course transcript cue. Returns spoken lines with ' +
      'course, file, timestamp, and file_id/start_ms for follow-up context queries.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (matched as literal words)' },
        limit: { type: 'number', description: 'Max hits, default 20' },
        course: { type: 'string', description: 'Optional course-name substring filter' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context',
    description:
      'Surrounding cues from one transcript file around a timestamp — use after ' +
      'search_transcripts to read the full passage.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'number', description: 'file_id from a search hit' },
        around_ms: { type: 'number', description: 'start_ms from a search hit' },
        window_s: { type: 'number', description: 'Seconds of context each side, default 90' },
      },
      required: ['file_id', 'around_ms'],
    },
  },
  {
    name: 'search_lessons',
    description:
      'Search LESSON TITLES across the library. Try this BEFORE search_transcripts when asking ' +
      'whether a topic is taught anywhere: instructors rarely speak their own lesson titles, so ' +
      'an entire module can be invisible to cue search. Terms are ANDed against the lesson path.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match against the lesson path' },
        limit: { type: 'number', description: 'Max lessons, default 30' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_assets',
    description:
      'Search the OWNED asset library (packs, not courses): 3D models, materials, plugins, game ' +
      'systems. Answers "do I already own something for this?" before buying another. Returns ' +
      'name, marketplace title, seller, category, ecosystem, size and path on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms' },
        limit: { type: 'number', description: 'Max hits, default 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_courses',
    description: 'List indexed courses with video counts, hours, and subtitle coverage.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional course-name substring filter' },
      },
    },
  },
];
const toolNames = new Set(tools.map((t) => t.name));

function callTool(name, args) {
  if (name === 'search_transcripts') {
    const limit = Math.max(1, Math.min(Math.trunc(asFinite(args.limit, 20)), 100));
    const match = ftsQuote(String(args.query ?? ''));
    if (!match) return 'Empty query.';
    const rows = args.course
      ? searchInCourseStmt.all(match, likeEscape(String(args.course)), limit)
      : searchStmt.all(match, limit);
    if (rows.length === 0) return 'No transcript cues matched.';
    return rows
      .map(
        (r) =>
          `[${r.course}] ${r.rel_path} @ ${stamp(r.start_ms)} — ${r.text}\n` +
          `  (file_id=${r.file_id}, start_ms=${r.start_ms}, video=${videoHint(r.abs_path)})`,
      )
      .join('\n');
  }
  if (name === 'get_context') {
    // FTS5 UNINDEXED columns have no type affinity: a string file_id would silently
    // match nothing, so coerce and validate both numbers explicitly.
    const fileId = Math.trunc(asFinite(args.file_id, Number.NaN));
    const at = asFinite(args.around_ms, Number.NaN);
    if (!Number.isFinite(fileId) || !Number.isFinite(at)) {
      return 'file_id and around_ms must be numbers (take them from a search hit).';
    }
    const w = Math.max(1, asFinite(args.window_s, 90)) * 1000;
    const rows = contextStmt.all(fileId, at - w, at + w);
    if (rows.length === 0) return 'No cues in that window.';
    return rows.map((r) => `@ ${stamp(r.start_ms)}  ${r.text}`).join('\n');
  }
  if (name === 'search_lessons') {
    const limit = Math.min(args.limit ?? 30, 200);
    const terms = String(args.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return 'Empty query.';
    // Escape LIKE wildcards so a query containing % or _ cannot match everything.
    // First term narrows in SQL; the rest filter in JS, so one prepared
    // statement serves any number of terms.
    let rows = lessonsStmt.all(`%${likeEscape(terms[0])}%`, 2000);
    for (const t of terms.slice(1)) {
      rows = rows.filter((r) => r.rel_path.toLowerCase().includes(t));
    }
    if (rows.length === 0) return 'No lesson titles matched.';
    return rows
      .slice(0, limit)
      .map((r) => {
        const mins = r.duration_seconds ? `${Math.round(r.duration_seconds / 60)}m` : '—';
        return `[${r.course}] ${r.rel_path}  (${mins})`;
      })
      .join('\n');
  }
  if (name === 'search_assets') {
    const limit = Math.min(args.limit ?? 20, 100);
    const match = ftsQuote(String(args.query ?? ''));
    if (!match) return 'Empty query.';
    const rows = assetsStmt.all(match, limit);
    if (rows.length === 0) return 'No owned assets matched.';
    return rows
      .map((r) => {
        const gb = r.file_size ? `${(r.file_size / 1e9).toFixed(1)} GB` : '—';
        let cats = '';
        try {
          cats = r.orbital_categories ? JSON.parse(r.orbital_categories).join('/') : '';
        } catch {
          cats = '';
        }
        const title =
          r.orbital_title && r.orbital_title !== r.name ? ` ("${r.orbital_title}")` : '';
        const by = r.orbital_seller_name ? ` by ${r.orbital_seller_name}` : '';
        return `${r.name}${title}${by} — ${r.ecosystem}${cats ? `, ${cats}` : ''}, ${gb}\n  ${r.file_path}`;
      })
      .join('\n');
  }
  if (name === 'list_courses') {
    const rows = coursesStmt.all(likeEscape(String(args.query ?? '')));
    if (rows.length === 0) return 'No courses matched.';
    return rows
      .map((r) => `${r.name} — ${r.videos} videos, ${r.hours ?? 0} h, ${r.subs} subtitle files`)
      .join('\n');
  }
  throw invalidParams(`Unknown tool: ${name}`);
}

function invalidParams(message) {
  return Object.assign(new Error(message), { code: -32602 });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'omnidex-oracle', version: '0.1.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string' || !toolNames.has(name)) {
      throw invalidParams(`Unknown or missing tool name: ${name}`);
    }
    try {
      const text = callTool(name, params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  }
  if (id === undefined) return undefined; // notifications need no reply
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
  try {
    const result = handle(msg);
    if (msg.id !== undefined && result !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
    }
  } catch (e) {
    if (msg.id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: e.code ?? -32603, message: e.message },
        })}\n`,
      );
    }
  }
});
