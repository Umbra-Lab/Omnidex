import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { aiTagsRepo } from '../../db/repos';
import { createTestDb, seedAsset } from '../../db/repos/__tests__/fixtures/test-db';
import { readCliJson } from '../claude-cli';
import { enrichTags, enrichTagsExitCode } from '../enrich-tags';
import { buildTagPrompt, cleanTag, packCard, parseTagReply } from '../prompt';

const migration = (name: string) =>
  readFileSync(resolve('electron/main/db/migrations', name), 'utf8');

function db(): Database {
  const d = createTestDb();
  d.exec(migration('20261108000000_dcc_index.up.sql'));
  d.exec(migration('20261128000000_ai_tags.up.sql'));
  return d;
}

describe('tag prompt and reply', () => {
  const pack = {
    id: 7,
    name: 'ModularSciFiCorridor',
    asset_type: 'unreal_pack',
    display_title: null,
    orbital_title: 'Modular Sci-Fi Corridor',
    orbital_seller_name: 'Some Seller',
    orbital_categories: 'Environments',
    description: null,
    orbital_description: '<p>A <b>modular</b>   kit of corridor pieces.</p>',
    scan_search_text: 'Modular Sci Fi Corridor SciFi',
  };

  it('shows only filled fields, with markup stripped', () => {
    const card = packCard(pack);
    expect(card).toContain('id 7: ModularSciFiCorridor');
    expect(card).toContain('title: Modular Sci-Fi Corridor');
    expect(card).toContain('about: A modular kit of corridor pieces.');
    expect(card).not.toContain('<p>');
    expect(packCard({ ...pack, orbital_seller_name: null })).not.toContain('seller');
    expect(buildTagPrompt([pack])).toMatch(/only a JSON object/);
  });

  it('keeps short lowercase phrases for ids that were asked about', () => {
    const reply =
      'Here you go:\n{"7": ["Hallway", "sci-fi", "sci-fi", "a b c d", 3, "x", "Environment!"], "99": ["nope"]}';
    const tags = parseTagReply(reply, new Set([7]));
    expect(tags.get(7)).toEqual(['hallway', 'sci-fi', 'environment']);
    expect(tags.has(99)).toBe(false);
    expect(parseTagReply('no json here', new Set([7])).size).toBe(0);
    expect(parseTagReply('{"7": "hallway"}', new Set([7])).size).toBe(0);
    expect(cleanTag('  Low   Poly ')).toBe('low poly');
  });

  it('reads the CLI JSON envelope and throws its errors', () => {
    expect(readCliJson('{"type":"result","result":"{\\"1\\":[]}","is_error":false}')).toBe(
      '{"1":[]}',
    );
    expect(() => readCliJson('{"result":"Not logged in","is_error":true}')).toThrow(
      'Not logged in',
    );
    expect(() => readCliJson('Error: boom')).toThrow(/other than JSON/);
  });
});

describe('enrichTags', () => {
  let d: Database;
  beforeEach(() => {
    d = db();
  });

  const tagsOf = (id: number) =>
    (d.prepare('SELECT ai_tags FROM assets WHERE id = ?').get(id) as { ai_tags: string | null })
      .ai_tags;

  it('tags packs in batches, makes them searchable, and skips them next run', async () => {
    const a = seedAsset(d, { name: 'ModularSciFiCorridor', file_path: '/p/a' });
    const b = seedAsset(d, { name: 'Rock Pack', file_path: '/p/b' });
    const course = seedAsset(d, { name: 'Course', file_path: '/c', content_format: 'course' });
    const prompts: string[] = [];
    const run = async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ [a]: ['hallway', 'sci-fi'], [b]: [] });
    };
    const r = await enrichTags(d, { run, batchSize: 10 });
    expect(r).toMatchObject({ total: 2, tagged: 1, empty: 1, skipped: 0, failedCalls: 0 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Course');
    expect(tagsOf(a)).toBe('hallway, sci-fi');
    expect(tagsOf(b)).toBe('');
    expect(tagsOf(course)).toBeNull();
    // The FTS column holds them, so "hallway" now finds the corridor pack.
    const hit = d
      .prepare('SELECT rowid FROM assets_fts WHERE assets_fts MATCH ?')
      .all('"hallway"') as { rowid: number }[];
    expect(hit.map((h) => h.rowid)).toEqual([a]);
    expect((await enrichTags(d, { run })).total).toBe(0);
    expect(aiTagsRepo.clearAiTags(d)).toBe(2);
    expect(aiTagsRepo.countUntagged(d)).toBe(2);
  });

  it('leaves packs the model skipped for the next run', async () => {
    const a = seedAsset(d, { name: 'A', file_path: '/p/a' });
    seedAsset(d, { name: 'B', file_path: '/p/b' });
    const r = await enrichTags(d, { run: async () => JSON.stringify({ [a]: ['x tag'] }) });
    expect(r).toMatchObject({ tagged: 1, skipped: 1 });
    expect(aiTagsRepo.countUntagged(d)).toBe(1);
    expect(enrichTagsExitCode(r)).toBe(0);
  });

  it('stops after two failed calls in a row and says why', async () => {
    for (let i = 0; i < 5; i++) seedAsset(d, { name: `P${i}`, file_path: `/p/${i}` });
    let calls = 0;
    const r = await enrichTags(d, {
      batchSize: 1,
      run: async () => {
        calls += 1;
        throw new Error('Not logged in');
      },
    });
    expect(calls).toBe(2);
    expect(r).toMatchObject({ total: 5, tagged: 0, skipped: 5, failedCalls: 2 });
    expect(r.stoppedEarly).toBe('Not logged in');
    expect(enrichTagsExitCode(r)).toBe(1);
  });

  it('honours the limit, most-rated packs first', async () => {
    seedAsset(d, { name: 'Plain', file_path: '/p/plain' });
    const popular = seedAsset(d, { name: 'Popular', file_path: '/p/pop' });
    d.prepare('UPDATE assets SET orbital_rating_count = 900 WHERE id = ?').run(popular);
    let seen = '';
    await enrichTags(d, {
      limit: 1,
      run: async (p) => {
        seen = p;
        return '{}';
      },
    });
    expect(seen).toContain('Popular');
    expect(seen).not.toContain('Plain');
  });
});
