import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * FAB library enrichment: fetch failures must be reported (not look like an
 * empty library), mid-pagination auth expiry must surface as auth-required,
 * the listing-type fallback must apply, and id rematch must work through
 * either identifier. `fetch` and the DB are mocked; no network.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../../db', () => ({ openDatabase: () => h.db }));

import {
  enrichFab,
  exchangeEpicAuthCode,
  FAB_AUTH_REDIRECT_URL,
  FabAuthRequiredError,
  parseAuthorizationCode,
} from '../enrich';

const SCHEMA = /* sql */ `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'unreal_pack',
  content_format TEXT,
  scan_location_id INTEGER NOT NULL DEFAULT 1,
  fab_owned INTEGER NOT NULL DEFAULT 0,
  fab_item_id TEXT,
  orbital_title TEXT,
  orbital_description TEXT,
  orbital_seller_name TEXT,
  orbital_thumbnail_url TEXT,
  orbital_source_url TEXT,
  orbital_supported_versions TEXT,
  orbital_categories TEXT,
  orbital_last_checked_timestamp TEXT,
  tags TEXT
);`;

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const opts = { fabToken: 't', fabAccount: 'acct-12345678', onProgress: () => {} };
let fetchMock: ReturnType<typeof vi.fn>;

function seed(name: string, fabItemId: string | null = null): void {
  (h.db as Database)
    .prepare('INSERT INTO assets (name, fab_item_id) VALUES (?, ?)')
    .run(name, fabItemId);
}
function row(name: string): { fab_owned: number; asset_type: string; fab_item_id: string | null } {
  return (h.db as Database)
    .prepare('SELECT fab_owned, asset_type, fab_item_id FROM assets WHERE name = ?')
    .get(name) as { fab_owned: number; asset_type: string; fab_item_id: string | null };
}

beforeEach(() => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  h.db = d;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  (h.db as unknown as { close: () => void }).close();
  vi.unstubAllGlobals();
});

describe('enrichFab fetch failures', () => {
  it('reports an HTTP error mid-library and does not enrich from the partial library', async () => {
    seed('Pack One');
    fetchMock
      .mockResolvedValueOnce(
        json(200, { results: [{ title: 'Pack One', assetId: 'a1' }], cursors: { next: 'c2' } }),
      )
      .mockResolvedValueOnce(json(500, { error: 'boom' }));

    const r = await enrichFab(opts);
    expect(r.fetchError).toMatch(/500/);
    expect(r.updated).toBe(0);
    expect(row('Pack One').fab_owned).toBe(0);
  });

  it('reports a network error as a failure rather than an empty library', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const r = await enrichFab(opts);
    expect(r.fetchError).toMatch(/fetch failed/);
    expect(r.libraryItems).toBe(0);
  });

  it('surfaces a 401 mid-pagination as auth-required, not a silent partial result', async () => {
    seed('Pack One');
    fetchMock
      .mockResolvedValueOnce(
        json(200, { results: [{ title: 'Pack One', assetId: 'a1' }], cursors: { next: 'c2' } }),
      )
      .mockResolvedValue(json(401, { error: 'expired' }));

    await expect(enrichFab(opts)).rejects.toBeInstanceOf(FabAuthRequiredError);
    expect(row('Pack One').fab_owned).toBe(0);
  });
});

describe('enrichFab token expiry mid-library', () => {
  const credsPath = `${app.getPath('userData')}/epic_credentials.json`;
  afterEach(() => rmSync(credsPath, { force: true }));

  it('a second expiry after a successful refresh surfaces as auth-required', async () => {
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(
      credsPath,
      JSON.stringify({ access_token: 'old', refresh_token: 'r', account_id: 'acct-12345678' }),
    );
    seed('Pack One');
    let libraryCalls = 0;
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/token')) {
        refreshCalls += 1;
        // First refresh works, the second is rejected.
        return refreshCalls === 1
          ? json(200, { access_token: 'new', refresh_token: 'r2', account_id: 'acct-12345678' })
          : json(400, { error: 'invalid_grant' });
      }
      libraryCalls += 1;
      if (libraryCalls === 1) return json(401, {});
      if (libraryCalls === 2) {
        return json(200, { results: [{ title: 'Pack One' }], cursors: { next: 'c2' } });
      }
      return json(401, {});
    });

    await expect(enrichFab(opts)).rejects.toBeInstanceOf(FabAuthRequiredError);
    expect(row('Pack One').fab_owned).toBe(0);
  });
});

describe('enrichFab matching', () => {
  it('falls back to "Asset" when the listing has no listingType', async () => {
    seed('Pack One');
    fetchMock.mockResolvedValueOnce(json(200, { results: [{ title: 'Pack One', assetId: 'a1' }] }));
    await enrichFab(opts);
    expect(row('Pack One').asset_type).toBe('Asset');
  });

  it('rematches by stored listing id even when the item also has a different assetId', async () => {
    seed('Renamed locally', 'L-1');
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            title: 'Remote Title',
            assetId: 'A-1',
            listingType: '3D',
            customAttributes: [{ ListingIdentifier: 'L-1' }],
          },
        ],
      }),
    );
    const r = await enrichFab(opts);
    expect(r.updated).toBe(1);
    expect(row('Renamed locally')).toMatchObject({ fab_owned: 1, asset_type: '3D Asset' });
  });

  it('rematches by assetId too', async () => {
    seed('Renamed locally', 'A-1');
    fetchMock.mockResolvedValueOnce(
      json(200, {
        results: [
          {
            title: 'Remote Title',
            assetId: 'A-1',
            customAttributes: [{ ListingIdentifier: 'L-1' }],
          },
        ],
      }),
    );
    const r = await enrichFab(opts);
    expect(r.updated).toBe(1);
  });
});

describe('parseAuthorizationCode', () => {
  const code = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('takes the code out of the whole JSON page Epic shows', () => {
    const page = `{"warning":"Do not share this code with any 3rd party service.","redirectUrl":"https://localhost/launcher/authorized?code=${code}","authorizationCode":"${code}","exchangeCode":null,"sid":null}`;
    expect(parseAuthorizationCode(page)).toBe(code);
  });

  it('accepts the bare code, with or without quotes and whitespace', () => {
    expect(parseAuthorizationCode(code)).toBe(code);
    expect(parseAuthorizationCode(`  "${code}"\n`)).toBe(code);
  });

  it('accepts a redirect URL carrying code=', () => {
    expect(parseAuthorizationCode(`https://localhost/launcher/authorized?code=${code}`)).toBe(code);
  });

  it('returns null when Epic sent no code (signed out) or the paste is not a code', () => {
    expect(parseAuthorizationCode('{"redirectUrl":"x","authorizationCode":null}')).toBeNull();
    expect(parseAuthorizationCode('')).toBeNull();
    expect(parseAuthorizationCode('hello world')).toBeNull();
    // A malformed %-escape must not throw out of the CLI's re-auth.
    expect(parseAuthorizationCode('https://x/?code=%E0%A4%A')).toBeNull();
  });
});

describe('Epic sign-in', () => {
  const credsPath = `${app.getPath('userData')}/epic_credentials.json`;
  beforeEach(() => mkdirSync(dirname(credsPath), { recursive: true }));
  afterEach(() => rmSync(credsPath, { force: true }));

  it('exchanges a code and saves the login where enrichFab reads it', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        access_token: 'tok',
        refresh_token: 'ref',
        account_id: 'acct',
        displayName: 'Bran',
      }),
    );
    const r = await exchangeEpicAuthCode('the-code', credsPath);
    expect(r).toEqual({ ok: true, displayName: 'Bran' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/oauth/token');
    expect(init.body).toBe('grant_type=authorization_code&code=the-code');
    if (process.platform !== 'win32') {
      expect(statSync(credsPath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(credsPath, 'utf8'))).toMatchObject({
      access_token: 'tok',
      refresh_token: 'ref',
      account_id: 'acct',
    });
  });

  it('explains a rejected code and saves nothing', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { errorCode: 'invalid_grant' }));
    const r = await exchangeEpicAuthCode('stale', credsPath);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.message).toMatch(/work once and expire/);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('treats a non-JSON 200 as a failure, not an exception', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      text: async () => '<html>',
    } as unknown as Response);
    const r = await exchangeEpicAuthCode('x', credsPath);
    expect(r.ok).toBe(false);
    expect(existsSync(credsPath)).toBe(false);
  });

  it('closes the progress run before asking the app to sign in again', async () => {
    writeFileSync(credsPath, JSON.stringify({ access_token: 'old', account_id: 'acct-12345678' }));
    fetchMock.mockResolvedValue(json(401, {}));
    const phases: string[] = [];
    await expect(enrichFab({ onProgress: (p) => phases.push(p.phase) })).rejects.toBeInstanceOf(
      FabAuthRequiredError,
    );
    expect(phases[0]).toBe('start');
    expect(phases.at(-1)).toBe('error');
  });

  it('reports a network failure instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await exchangeEpicAuthCode('x', credsPath);
    expect(r).toEqual({ ok: false, message: 'Could not reach Epic: ENOTFOUND' });
  });

  it('a first sync with no login asks the renderer to sign in, not to run a CLI', async () => {
    const err = await enrichFab({ onProgress: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FabAuthRequiredError);
    expect((err as FabAuthRequiredError).redirectUrl).toBe(FAB_AUTH_REDIRECT_URL);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a corrupt saved login asks for sign-in instead of throwing a SyntaxError', async () => {
    writeFileSync(credsPath, '{"access_token": "tok", ');
    const err = await enrichFab({ onProgress: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FabAuthRequiredError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a first CLI sync signs in through the prompt, then fetches the library', async () => {
    seed('Pack One');
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/oauth/token')
        ? json(200, { access_token: 'tok', refresh_token: 'ref', account_id: 'acct-12345678' })
        : json(200, { results: [{ title: 'Pack One', assetId: 'a1' }], cursors: {} }),
    );
    const prompt = vi.fn(async () => '{"authorizationCode":"abcdefgh1234"}');
    const r = await enrichFab({ onProgress: () => {}, promptAuthCode: prompt });
    expect(prompt).toHaveBeenCalledWith(FAB_AUTH_REDIRECT_URL);
    expect(r.updated).toBe(1);
    expect(row('Pack One').fab_owned).toBe(1);
  });
});
