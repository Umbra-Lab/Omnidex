/**
 * Query building for the Oracle's FTS5 searches: what turns an agent's words into a MATCH
 * expression, and what to try when that expression finds too little.
 *
 * Three steps, each only when the one before found fewer than `FEW` hits:
 *
 *   1. Every word, ANDed. Asset and docs words also prefix-match (`"water"*`), like the
 *      app's search box. Transcript words do not: spoken words are whole words, porter
 *      stemming already covers word forms, and a prefix on a 4.6M-cue index is expensive.
 *   2. Typo correction. A word with no hits at all is swapped for the nearest word in the
 *      index's own vocabulary (read through an `fts5vocab` table), and step 1 runs again.
 *   3. Transcripts and assets: any of the words (`OR`), common English words dropped,
 *      ranked by BM25, which already puts rows holding more of the words first. A cue is
 *      one subtitle line, so "how to add a ribbon renderer in niagara" never has every
 *      word in one cue.
 *
 * Every relaxation is reported back as a note, so the agent knows what it is looking at.
 *
 * `legacy: true` turns all of it off (exact words, ANDed, nothing else): the scoring
 * script uses it to compare against the old behaviour on a real library.
 */

/** Below this many hits a search tries the next, looser step. */
export const FEW = 5;

// Dropped only from the OR step, where they would match most of the corpus and swamp
// the ranking. The AND step keeps every word.
const STOPWORDS = new Set(
  (
    'a an and are as at be but by can do does did for from had has have how i if in into ' +
    'is it its just me my no not now of on or our so than that the their them then there ' +
    'these they this to too up us was we were what when where which who why will with ' +
    'would you your ' +
    // Spoken filler that is in a large share of transcript cues.
    'about all also any actually basically get going gonna here just like one ok okay ' +
    'out really some use very want'
  ).split(' '),
);

/** Split a query into words, dropping FTS syntax characters that cannot be quoted away. */
export function queryTerms(query) {
  return String(query ?? '')
    .split(/\s+/)
    .map((t) => t.replaceAll('"', ''))
    .filter(Boolean);
}

// Prefix only plain words: `"c++"*` would tokenize to `c*` and match everything with a c.
function quote(term, prefix) {
  return `"${term}"${prefix && /^[\p{L}\p{N}]+$/u.test(term) ? '*' : ''}`;
}

export function andQuery(terms, prefix) {
  return terms.map((t) => quote(t, prefix)).join(' ');
}

export function orQuery(terms, prefix) {
  return terms.map((t) => quote(t, prefix)).join(' OR ');
}

/**
 * Words worth keeping in an OR query. None if every word is a stopword: an OR of only
 * common words would rank most of the transcript corpus (seconds at 4.6M cues) for
 * results that mean nothing.
 */
export function contentTerms(terms) {
  return terms.filter((t) => !STOPWORDS.has(t.toLowerCase()));
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
export function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur.push(d);
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** How many edits a word of this length may need to count as a typo of another. */
function maxEdits(length) {
  if (length < 4) return 0;
  return length < 8 ? 1 : 2;
}

// The index stores porter stems ("materials" → "materi"), so a correctly spelled word can
// sit a suffix away from its vocabulary entry. Comparing the stripped forms too keeps a
// typo of a suffixed word ("matrials") within reach of its stem.
const SUFFIXES = [
  'ations',
  'ation',
  'ions',
  'ion',
  'ings',
  'ing',
  'als',
  'al',
  'ers',
  'er',
  'ies',
  'es',
  'ed',
  's',
  // Porter drops a silent e ("database" → "databas"), so "databse" is one edit from the
  // stem only once its own e is gone too.
  'e',
];
function forms(word) {
  const out = [word];
  for (const s of SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) out.push(word.slice(0, -s.length));
  }
  return out;
}

/**
 * Pick the vocabulary word a misspelt word most likely meant: fewest edits, then the word
 * in the most rows. Candidates share the first letter (a first-letter typo is not caught;
 * the trade is reading one slice of the vocabulary instead of all of it).
 *
 * @param {string} word lower-cased query word
 * @param {{term: string, doc: number}[]} vocab entries starting with the same letter
 */
export function nearestTerm(word, vocab) {
  const limit = maxEdits(word.length);
  if (limit === 0) return null;
  const tries = forms(word);
  let best = null;
  for (const { term, doc } of vocab) {
    let d = Number.POSITIVE_INFINITY;
    for (const f of tries) {
      if (Math.abs(f.length - term.length) > limit) continue;
      d = Math.min(d, editDistance(f, term));
    }
    if (d > limit) continue;
    if (!best || d < best.d || (d === best.d && doc > best.doc)) best = { term, doc, d };
  }
  return best?.term ?? null;
}

/**
 * Bind the searches to an open database (read-only is fine: the vocabulary tables are
 * TEMP, which SQLite allows on a read-only connection).
 */
export function createSearch(db, { legacy = false } = {}) {
  const vocabTables = new Map();
  function vocabFor(ftsTable) {
    let name = vocabTables.get(ftsTable);
    if (!name) {
      name = `oracle_vocab_${ftsTable}`;
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS temp.${name} USING fts5vocab(main, ${ftsTable}, 'row')`,
      );
      vocabTables.set(ftsTable, name);
    }
    return name;
  }
  const probes = new Map();
  function hasHit(ftsTable, term, prefix) {
    let stmt = probes.get(ftsTable);
    if (!stmt) {
      stmt = db.prepare(`SELECT 1 FROM ${ftsTable} WHERE ${ftsTable} MATCH ? LIMIT 1`);
      probes.set(ftsTable, stmt);
    }
    return stmt.get(quote(term, prefix)) !== undefined;
  }
  const vocabStmts = new Map();
  // One slice per first letter, kept for the life of the server: reading a slice of a
  // 4.6M-cue index costs tens of milliseconds and the vocabulary only changes on rescan.
  const vocabCache = new Map();
  function vocabSlice(ftsTable, first) {
    const cacheKey = `${ftsTable}\u0000${first}`;
    const cached = vocabCache.get(cacheKey);
    if (cached) return cached;
    const table = vocabFor(ftsTable);
    let stmt = vocabStmts.get(table);
    if (!stmt) {
      stmt = db.prepare(`SELECT term, doc FROM temp.${table} WHERE term >= ? AND term < ?`);
      vocabStmts.set(table, stmt);
    }
    const next = String.fromCodePoint(first.codePointAt(0) + 1);
    const rows = stmt.all(first, next);
    vocabCache.set(cacheKey, rows);
    return rows;
  }

  /**
   * Swap words with no hits for their nearest vocabulary word. Vocabulary words are
   * porter stems, and a stem fed back through the porter tokenizer can be stemmed again
   * ("databas" → "databa", which matches nothing), so a correction is always searched as
   * a prefix: `"databas"*` matches the stored stem and every word built on it. Words with
   * digits are left alone: "4090" is not a typo of "4080".
   */
  function correct(ftsTable, terms, prefix) {
    const fixes = [];
    const stems = new Set();
    const out = terms.map((t) => {
      const lower = t.toLowerCase();
      if (maxEdits(lower.length) === 0 || /\d/.test(lower) || hasHit(ftsTable, lower, prefix)) {
        return t;
      }
      const fix = nearestTerm(
        lower,
        vocabSlice(ftsTable, String.fromCodePoint(lower.codePointAt(0))),
      );
      if (!fix) return t;
      fixes.push(`"${t}" → words starting "${fix}"`);
      stems.add(fix);
      return fix;
    });
    return { terms: out, fixes, stems };
  }

  /** `and` or `or` query over terms; corrected stems always prefix-match (see correct). */
  function build(terms, prefix, stems, joiner) {
    return terms.map((t) => quote(t, prefix || stems.has(t))).join(joiner);
  }

  /**
   * Run `run(match, limit)` through the steps above. Rows are deduplicated by `key(row)`.
   * Returns { rows, notes }.
   */
  function staged(ftsTable, query, limit, run, key, { prefix, orFallback }) {
    let terms = queryTerms(query);
    if (terms.length === 0) return { rows: [], notes: [], empty: true };
    if (legacy) return { rows: run(andQuery(terms, false), limit), notes: [] };

    let stems = new Set();
    let rows = run(andQuery(terms, prefix), limit);
    const notes = [];
    const enough = Math.min(FEW, limit);
    if (rows.length >= enough) return { rows, notes };

    const fixed = correct(ftsTable, terms, prefix);
    if (fixed.fixes.length > 0) {
      terms = fixed.terms;
      stems = fixed.stems;
      const again = run(build(terms, prefix, stems, ' '), limit);
      notes.push(`Corrected spelling: ${fixed.fixes.join(', ')}.`);
      rows = again;
      if (rows.length >= enough) return { rows, notes };
    }

    if (orFallback) {
      const loose = contentTerms(terms);
      const strictQuery = build(terms, prefix, stems, ' ');
      const looseQuery = build(loose, prefix, stems, ' OR ');
      if (loose.length > 0 && looseQuery !== strictQuery) {
        const seen = new Set(rows.map(key));
        const extra = run(looseQuery, limit).filter((r) => !seen.has(key(r)));
        if (extra.length > 0) {
          const kept = extra.slice(0, limit - rows.length);
          notes.push(
            rows.length > 0
              ? `Only ${rows.length} result(s) had every word; the rest match some of: ${loose.join(', ')}.`
              : `No result had every word; these match some of: ${loose.join(', ')}.`,
          );
          rows = rows.concat(kept);
        }
      }
    }
    return { rows, notes };
  }

  const transcriptSql = (extra) => `
    SELECT q.id AS cue_id, q.text, q.file_id, q.start_ms, c.rel_path, c.abs_path, a.name AS course
    FROM transcript_fts t
    JOIN transcript_cues q ON q.id = t.rowid
    JOIN course_files c ON c.id = q.file_id
    JOIN assets a ON a.id = c.asset_id
    WHERE transcript_fts MATCH ? ${extra}
    ORDER BY rank
    LIMIT ?`;
  const transcriptStmt = db.prepare(transcriptSql(''));
  const transcriptInCourseStmt = db.prepare(
    transcriptSql("AND a.name LIKE '%' || ? || '%' ESCAPE '\\'"),
  );

  /**
   * Same weights as the app's search box (`searchAssets` in db/repos/assets.ts): name
   * 10x, tags 5x, Orbital title 8x. scan_search_text (split names, DCC and Unity context)
   * takes the default 1x.
   */
  const assetsStmt = db.prepare(`
    SELECT a.id, a.name, a.orbital_title, a.file_path, a.file_size, a.asset_type,
           a.orbital_categories, a.orbital_seller_name,
           COALESCE(a.asset_ecosystem, a.ecosystem, 'unknown') AS ecosystem
    FROM assets a
    JOIN assets_fts f ON f.rowid = a.id
    WHERE assets_fts MATCH ?
      AND a.content_format IS NULL
      AND a.missing_since IS NULL
    ORDER BY bm25(assets_fts, 10.0, 1.0, 5.0, 8.0, 2.0, 2.0, 1.0)
    LIMIT ?`);

  return {
    /** @param {string} likeCourse already LIKE-escaped course filter, or '' for none */
    transcripts(query, limit, likeCourse = '') {
      const run = likeCourse
        ? (match, n) => transcriptInCourseStmt.all(match, likeCourse, n)
        : (match, n) => transcriptStmt.all(match, n);
      return staged('transcript_fts', query, limit, run, (r) => r.cue_id, {
        prefix: false,
        orFallback: true,
      });
    },
    assets(query, limit) {
      return staged(
        'assets_fts',
        query,
        limit,
        (m, n) => assetsStmt.all(m, n),
        (r) => r.id,
        {
          prefix: true,
          orFallback: true,
        },
      );
    },
  };
}
