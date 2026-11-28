import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
// The Oracle MCP server's query builder (plain .mjs, typed by search.d.mts).
import {
  contentTerms,
  createSearch,
  editDistance,
  nearestTerm,
  queryTerms,
  stemPrefix,
} from '../../../../scripts/oracle-mcp/search.mjs';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';

describe('Oracle query helpers', () => {
  it('drops quotes so input can never become FTS syntax', () => {
    expect(queryTerms(' "fire"  vfx" ')).toEqual(['fire', 'vfx']);
  });

  it('drops stopwords for the OR step, leaving nothing if that is all there is', () => {
    expect(contentTerms(['how', 'to', 'add', 'niagara'])).toEqual(['add', 'niagara']);
    expect(contentTerms(['to', 'be'])).toEqual([]);
  });

  it('counts a transposition as one edit', () => {
    expect(editDistance('fier', 'fire')).toBe(1);
    expect(editDistance('niagra', 'niagara')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('picks the closest vocabulary word, then the most common', () => {
    const vocab = [
      { term: 'niagara', doc: 40 },
      { term: 'nigeria', doc: 1 },
      { term: 'niagaras', doc: 2 },
    ];
    expect(nearestTerm('niagra', vocab)).toBe('niagara');
    // Short words are never corrected: too many real words are one edit apart.
    expect(nearestTerm('fir', [{ term: 'fire', doc: 9 }])).toBeNull();
    // A stem sits a suffix away from the typed word ("materials" is stored as "materi").
    expect(nearestTerm('matrials', [{ term: 'materi', doc: 5 }])).toBe('materi');
    // Porter drops a silent e: "database" is stored as "databas".
    expect(nearestTerm('databse', [{ term: 'databas', doc: 5 }])).toBe('databas');
  });
});

describe('stemPrefix', () => {
  const vocab = [
    { term: 'narr', doc: 3 },
    { term: 'narrow', doc: 9 },
    { term: 'ma', doc: 50 },
    { term: 'mate', doc: 2 },
  ];
  it('falls back to the porter stem a typed word starts with', () => {
    expect(stemPrefix('narrat', vocab)).toBe('narr');
    expect(stemPrefix('narraitve', vocab)).toBe('narr');
  });
  it('needs at least 4 letters and at most 5 cut off', () => {
    expect(stemPrefix('mat', vocab)).toBeNull();
    expect(stemPrefix('materail', vocab)).toBe('mate');
    expect(stemPrefix('narrativeness', vocab)).toBeNull();
  });
});

describe('Oracle staged search', () => {
  let db: Database;
  beforeEach(() => {
    db = createTestDb();
    db.exec(
      readFileSync(resolve('electron/main/db/migrations/20261108000000_dcc_index.up.sql'), 'utf8'),
    );
    db.exec(`
      CREATE TABLE course_files (id INTEGER PRIMARY KEY, asset_id INTEGER, kind TEXT,
        rel_path TEXT, abs_path TEXT, duration_seconds REAL, chapter TEXT, order_index INTEGER);
      CREATE TABLE transcript_cues (id INTEGER PRIMARY KEY, file_id INTEGER, text TEXT,
        start_ms INTEGER);
      CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_cues',
        content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER cues_ai AFTER INSERT ON transcript_cues BEGIN
        INSERT INTO transcript_fts (rowid, text) VALUES (new.id, new.text);
      END;`);
    const course = seedAsset(db, { name: 'Niagara Course', content_format: 'course' });
    db.prepare(
      "INSERT INTO course_files (id, asset_id, kind, rel_path, abs_path) VALUES (1, ?, 'subtitle', 'l1.srt', '/c/l1.srt')",
    ).run(course);
    const cue = db.prepare(
      'INSERT INTO transcript_cues (file_id, text, start_ms) VALUES (1, ?, ?)',
    );
    cue.run('So now we open the Niagara editor.', 1000);
    cue.run('Add a ribbon renderer to the emitter.', 5000);
    cue.run('How do I make the trail fade out?', 9000);
    cue.run('Every database needs an index.', 13000);
    seedAsset(db, { name: 'Stylized Water Shader', file_path: '/p/water' });
    seedAsset(db, { name: 'Niagara Fire Effects', file_path: '/p/fire' });
  });

  const texts = (rows: Record<string, unknown>[]) => rows.map((r) => r.text);
  const names = (rows: Record<string, unknown>[]) => rows.map((r) => r.name);

  it('falls back to any word when no cue holds them all, best match first', () => {
    const search = createSearch(db);
    const { rows, notes } = search.transcripts('how to add a ribbon renderer in niagara', 20);
    expect(texts(rows)[0]).toBe('Add a ribbon renderer to the emitter.');
    expect(texts(rows)).toContain('So now we open the Niagara editor.');
    expect(notes.join(' ')).toMatch(/No result had every word/);
  });

  it('keeps exact AND results first and says when it added looser ones', () => {
    const { rows, notes } = createSearch(db).transcripts('ribbon renderer', 20);
    expect(texts(rows)).toEqual(['Add a ribbon renderer to the emitter.']);
    expect(notes).toEqual([]);
  });

  it('corrects a misspelt word from the index vocabulary', () => {
    const t = createSearch(db).transcripts('niagra editor', 20);
    expect(texts(t.rows)).toEqual(['So now we open the Niagara editor.']);
    expect(t.notes[0]).toMatch(/"niagra" → words starting "niagara"/);
    // The correction is a stem ("databas"); searched exactly, porter would stem it again.
    const d = createSearch(db).transcripts('databbase', 20);
    expect(texts(d.rows)).toEqual(['Every database needs an index.']);
    expect(createSearch(db).transcripts('databse index', 20).rows).toHaveLength(1);
    const a = createSearch(db).assets('niagra', 20);
    expect(names(a.rows)).toEqual(['Niagara Fire Effects']);
  });

  it('finds a partial word longer than its stored stem', () => {
    seedAsset(db, { name: 'Narrative Quests', file_path: '/p/narr' });
    // "narrative" is stored as "narr", so "narrat"* matches nothing until the stem fallback.
    const a = createSearch(db).assets('narrat', 20);
    expect(names(a.rows)).toEqual(['Narrative Quests']);
    expect(names(createSearch(db).assets('narraitve', 20).rows)).toEqual(['Narrative Quests']);
    // A close word beats the stem fallback: "farmework" is "framework", not "farm".
    seedAsset(db, { name: 'Ascent Combat Framework', file_path: '/p/acf' });
    seedAsset(db, { name: 'Farm Tools', file_path: '/p/farm' });
    expect(names(createSearch(db).assets('farmework', 20).rows)).toEqual([
      'Ascent Combat Framework',
    ]);
    // A partial word that hits the wrong thing ("narrator") still widens to its stem.
    seedAsset(db, { name: 'Voice Pack', file_path: '/p/voice', description: 'narrator' });
    const wide = createSearch(db).assets('narrat', 20);
    expect(names(wide.rows)).toEqual(expect.arrayContaining(['Voice Pack', 'Narrative Quests']));
    // With another word in front, the widened group still parses (explicit AND).
    expect(names(createSearch(db).assets('quests narrat', 20).rows)).toContain('Narrative Quests');
  });

  it('prefix-matches asset words like the app search box', () => {
    expect(names(createSearch(db).assets('shad', 20).rows)).toEqual(['Stylized Water Shader']);
  });

  it('legacy mode is exact ANDed words and nothing else', () => {
    const legacy = createSearch(db, { legacy: true });
    expect(legacy.assets('shad', 20).rows).toEqual([]);
    expect(legacy.transcripts('niagra editor', 20).rows).toEqual([]);
    expect(legacy.transcripts('how to add a ribbon renderer', 20).rows).toEqual([]);
  });

  it('does not correct numbers or run an OR of only stopwords', () => {
    seedAsset(db, { name: 'RTX 4080 Benchmark Scene', file_path: '/p/rtx' });
    expect(createSearch(db).assets('4090', 20).rows).toEqual([]);
    expect(createSearch(db).transcripts('to be or not', 20).rows).toEqual([]);
  });

  it('never prefix-matches a word that is not plain letters or digits', () => {
    // "c++"* would tokenize to c* and match "Niagara Course" and everything else with a c.
    expect(createSearch(db).assets('c++', 20).rows).toEqual([]);
  });

  it('ignores stopwords and "pack" around a pack name instead of prefix-matching them', () => {
    // "do"* "i"* "have"* "a"* match almost anything, and few pack names say "pack": ANDing
    // them all returned five packs that merely mention integration and hid the one asked for.
    seedAsset(db, { name: 'Integration Toolkit', file_path: '/p/int' });
    for (let i = 0; i < 5; i++) {
      seedAsset(db, {
        name: `Door Kit ${i}`,
        file_path: `/p/door${i}`,
        description: 'a pack I have for integration of doors',
      });
    }
    const { rows } = createSearch(db).assets('do I have a integration pack', 20);
    expect(names(rows)[0]).toBe('Integration Toolkit');
    // A query of nothing but common words still searches them, exactly.
    expect(names(createSearch(db).assets('pack', 20).rows)).toContain('Door Kit 0');
  });

  it('still searches a query of only common words, and ranks typed titles first', () => {
    seedAsset(db, { name: 'Prop Pack', file_path: '/p/pp' });
    expect(names(createSearch(db).assets('the pack', 20).rows)).toContain('Prop Pack');
    expect(names(createSearch(db).assets('my assets', 20).rows)).toEqual([]);
    seedAsset(db, { name: 'Like A Dragon Anim', file_path: '/p/lad' });
    seedAsset(db, { name: 'Dragon Knight', file_path: '/p/dk' });
    expect(names(createSearch(db).assets('like a dragon', 20).rows)[0]).toBe('Like A Dragon Anim');
  });

  it('ranks whole-word matches above partial ones', () => {
    // "explosions"* also matches "explosion1"; the short prefab name won on BM25 alone.
    seedAsset(db, { name: 'Niagara Explosions', file_path: '/p/nx', description: 'big fx' });
    for (let i = 1; i <= 5; i++) {
      seedAsset(db, { name: `Niagara_Water_Explosion${i}`, file_path: `/p/w${i}` });
    }
    const { rows } = createSearch(db).assets('do I have a niagara explosions pack', 20);
    expect(names(rows)[0]).toBe('Niagara Explosions');
    expect(names(rows)).toContain('Niagara_Water_Explosion1');
  });

  it('tries neighbouring words joined when nothing has them all', () => {
    seedAsset(db, { name: 'WorldScape', file_path: '/p/ws' });
    seedAsset(db, { name: 'World', file_path: '/p/wd' });
    const { rows } = createSearch(db).assets('do I have a world scape pack', 20);
    expect(names(rows)[0]).toBe('WorldScape');
  });

  it('reports an empty query', () => {
    expect(createSearch(db).assets('  "" ', 5).empty).toBe(true);
  });

  it('scores golden queries through the real server, before and after', () => {
    seedAsset(db, {
      name: 'ModularSciFiCorridor',
      file_path: '/p/corridor',
      scan_search_text: 'Modular Sci Fi Corridor SciFi',
    });
    seedAsset(db, { name: 'rdLODtools', file_path: '/p/rdlod' });
    seedAsset(db, { name: 'Farm Tools', file_path: '/p/farmtools' });
    seedAsset(db, { name: 'FPSWeapons', file_path: '/p/fpsweapons' });
    seedAsset(db, { name: 'Brushify', file_path: '/p/brushify' });
    for (let i = 0; i < 3; i++) {
      seedAsset(db, { name: `brushed_metal_${i}`, file_path: `/p/brushed${i}` });
    }
    const dir = mkdtempSync(join(tmpdir(), 'omnidex-oracle-golden-'));
    try {
      const dbFile = join(dir, 'omnidex.db');
      db.prepare('VACUUM INTO ?').run(dbFile);
      writeFileSync(
        join(dir, 'oracle-golden.json'),
        JSON.stringify([
          { tool: 'search_assets', query: 'corridor', expect: 'SciFiCorridor' },
          { tool: 'search_assets', query: 'niagra', expect: 'Niagara Fire' },
          {
            tool: 'search_transcripts',
            query: 'how to add a ribbon renderer in niagara',
            expect: 'ribbon renderer',
          },
        ]),
      );
      const run = spawnSync(process.execPath, ['scripts/oracle-mcp/golden.mjs'], {
        env: { ...process.env, ORACLE_DB: dbFile },
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      expect(run.stdout).toContain('search_assets       hit@5: 1/2 before, 2/2 after');
      expect(run.stdout).toContain('search_transcripts  hit@5: 0/1 before, 1/1 after');

      // golden-gen.mjs writes a starter file from the same library, then golden.mjs scores it.
      rmSync(join(dir, 'oracle-golden.json'));
      const gen = spawnSync(process.execPath, ['scripts/oracle-mcp/golden-gen.mjs', dbFile], {
        encoding: 'utf8',
      });
      expect(gen.status).toBe(0);
      const generated = JSON.parse(readFileSync(join(dir, 'oracle-golden.json'), 'utf8'));
      expect(generated).toContainEqual({
        tool: 'search_assets',
        kind: 'hidden word',
        query: 'corridor',
        expect: 'ModularSciFiCorridor',
      });
      expect(generated.some((g: { tool: string }) => g.tool === 'search_transcripts')).toBe(true);
      const queries = generated.map((g: { query: string }) => g.query);
      // "dtools" is the splitter's guess at rdLODtools, and "brush" names every brushed
      // material: neither is a fair test of finding one pack.
      expect(queries.some((q: string) => q.includes('dtools'))).toBe(false);
      expect(queries).not.toContain('brush');
      // An acronym split the right way ("FPS Weapons") still makes queries.
      expect(queries).toContain('do I have a weapons pack');
      // Transcript questions use the cue's rarest words, not its first ones.
      expect(
        generated.find((g: { tool: string }) => g.tool === 'search_transcripts')?.query,
      ).toMatch(/^how do I /);
      const scored = spawnSync(process.execPath, ['scripts/oracle-mcp/golden.mjs'], {
        env: { ...process.env, ORACLE_DB: dbFile },
        encoding: 'utf8',
      });
      expect(scored.stdout).toMatch(/search_assets \/ typo\s+0\/\d+ before/);

      // The same pack copied into two folders is one result, with the second path under it.
      const copyDb = new DatabaseSync(dbFile);
      copyDb.exec(
        "INSERT INTO assets (name, file_path, file_size) VALUES ('Niagara Fire Effects', '/q/fire', 0)",
      );
      copyDb.close();
      const call = spawnSync(process.execPath, ['scripts/oracle-mcp/server.mjs'], {
        env: { ...process.env, ORACLE_DB: dbFile },
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: 'niagara fire' } } })}\n`,
        encoding: 'utf8',
      });
      const text = JSON.parse(call.stdout).result.content[0].text as string;
      expect(text.match(/^Niagara Fire Effects/gm)).toHaveLength(1);
      expect(text).toContain('also at /q/fire');

      // A copy under a short folder name folds in when its marketplace title and size match.
      const titled = new DatabaseSync(dbFile);
      titled.exec(`INSERT INTO assets (name, orbital_title, file_path, file_size) VALUES
        ('Cinemotion 3 Camera Kit', NULL, '/q/cine-full', 235),
        ('Cinemotion', 'Cinemotion 3 Camera Kit', '/q/cine', 235)`);
      titled.close();
      const cine = spawnSync(process.execPath, ['scripts/oracle-mcp/server.mjs'], {
        env: { ...process.env, ORACLE_DB: dbFile },
        input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: 'cinemotion' } } })}\n`,
        encoding: 'utf8',
      });
      const cineText = JSON.parse(cine.stdout).result.content[0].text as string;
      expect(cineText.match(/^Cinemotion/gm)).toHaveLength(1);
      expect(cineText).toMatch(/also at \/q\/cine/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
