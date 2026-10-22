import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ASK_DEFAULTS, readAskSettings } from '../settings';

function makeDb(rows: [string, string][] = []): Database {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE app_settings (
    key TEXT PRIMARY KEY, value TEXT, setting_type TEXT, description TEXT,
    created_date TEXT, modified_date TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO app_settings (key, value, setting_type) VALUES (?, ?, 'string')",
  );
  for (const [k, v] of rows) insert.run(k, v);
  return db as unknown as Database;
}

describe('readAskSettings', () => {
  it('uses the full defaults on a fresh install', () => {
    const s = readAskSettings(makeDb());
    // The regression this pins: Number(null) is 0, which is finite, and the
    // clamp turned an absent budget into the 8k floor instead of the default.
    expect(s.contextBudget).toBe(ASK_DEFAULTS.contextBudget);
    expect(s.provider).toBe('local');
    expect(s.localBaseUrl).toBe(ASK_DEFAULTS.localBaseUrl);
  });

  it('clamps a present-but-absurd budget instead of trusting it', () => {
    expect(readAskSettings(makeDb([['ask.context_budget', '5']])).contextBudget).toBe(8_000);
    expect(readAskSettings(makeDb([['ask.context_budget', '99999999']])).contextBudget).toBe(
      900_000,
    );
    expect(readAskSettings(makeDb([['ask.context_budget', 'garbage']])).contextBudget).toBe(
      ASK_DEFAULTS.contextBudget,
    );
  });

  it('reads a configured provider and model', () => {
    const s = readAskSettings(
      makeDb([
        ['ask.provider', 'claude-code'],
        ['ask.local_model', 'gemma-12b'],
      ]),
    );
    expect(s.provider).toBe('claude-code');
    expect(s.localModel).toBe('gemma-12b');
  });
});
