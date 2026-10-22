import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  readUpdateSettings,
  UPDATE_DEFAULTS,
  UPDATE_SETTING_KEYS,
  writeUpdateSettings,
} from '../settings';

function makeDb(rows: [string, string][] = []): Database {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE app_settings (
    key TEXT PRIMARY KEY, value TEXT, setting_type TEXT, description TEXT,
    created_date TEXT, modified_date TEXT
  )`);
  const insert = db.prepare(
    "INSERT INTO app_settings (key, value, setting_type) VALUES (?, ?, 'boolean')",
  );
  for (const [k, v] of rows) insert.run(k, v);
  return db as unknown as Database;
}

const stored = (db: Database) =>
  db
    .prepare('SELECT value, setting_type, description FROM app_settings WHERE key = ?')
    .get(UPDATE_SETTING_KEYS.autoCheck) as
    | { value: string; setting_type: string; description: string }
    | undefined;

describe('update settings', () => {
  it('defaults to off, so behavior is unchanged for everyone who never opens the setting', () => {
    expect(UPDATE_DEFAULTS.autoCheck).toBe(false);
    expect(readUpdateSettings(makeDb())).toEqual({ autoCheck: false });
  });

  it('persists a change and reads it back', () => {
    const db = makeDb();
    expect(writeUpdateSettings(db, { autoCheck: true })).toEqual({ autoCheck: true });
    expect(readUpdateSettings(db).autoCheck).toBe(true);

    writeUpdateSettings(db, { autoCheck: false });
    expect(readUpdateSettings(db).autoCheck).toBe(false);
  });

  it('writes a boolean-typed row with a description, updating rather than duplicating', () => {
    const db = makeDb();
    writeUpdateSettings(db, { autoCheck: true });
    writeUpdateSettings(db, { autoCheck: false });

    expect(stored(db)).toMatchObject({ value: 'false', setting_type: 'boolean' });
    expect(stored(db)?.description).toMatch(/off by default/i);
    const count = db.prepare('SELECT COUNT(*) AS n FROM app_settings').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('writes nothing for an empty patch', () => {
    const db = makeDb();
    writeUpdateSettings(db, {});
    expect(stored(db)).toBeUndefined();
  });

  it('fails closed: only the exact string "true" turns the check on', () => {
    // A hand-edited or legacy value must never enable a network request.
    for (const value of ['1', 'TRUE', 'yes', 'on', '', ' true', 'true ']) {
      const db = makeDb([[UPDATE_SETTING_KEYS.autoCheck, value]]);
      expect(readUpdateSettings(db).autoCheck, JSON.stringify(value)).toBe(false);
    }
    expect(readUpdateSettings(makeDb([[UPDATE_SETTING_KEYS.autoCheck, 'true']])).autoCheck).toBe(
      true,
    );
  });
});
