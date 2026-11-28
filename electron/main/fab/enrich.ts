import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { openDatabase } from '../db';
import { type ActionProgress, emitProgress } from '../progress/bus';

/**
 * FAB library enrichment service.
 *
 * Relocated from `index.ts`'s `runEnrichFabAndQuit` body (minus
 * `app.exit`/`process.exit`) so enrichment is callable from both the CLI and
 * tRPC. The FAB helpers (`fabSlug`, `fabCategoriesToTags`,
 * `extractFabListingId`, `FAB_LISTING_TYPE_MAP`), the `FabLibraryItem` /
 * `FabLibraryPage` / `EpicCredentials` interfaces, the token-refresh logic,
 * and the auth-code flow all move here. No auth/network ALGORITHM changes —
 * only the *input source* of the token moves from inline argv-parsing to the
 * `fabToken` / `fabAccount` options, and the interactive stdin prompt moves to
 * the injected `promptAuthCode` callback (the CLI supplies one; tRPC omits it,
 * in which case stale creds throw `FabAuthRequiredError` instead of blocking).
 */

// FAB listingType -> Omnidex asset_type. Anything not in the map falls back
// to the raw string from the API.
const FAB_LISTING_TYPE_MAP: Record<string, string> = {
  '3D': '3D Asset',
  '2D': '2D Asset',
  Audio: 'Audio',
  Blueprint: 'Blueprint',
  Blueprints: 'Blueprint',
  VFX: 'VFX',
  Animation: 'Animation',
  Animations: 'Animation',
  Plugin: 'Plugin',
  Plugin_Asset: 'Plugin',
  Complete_Project: 'Project',
  COMPLETE_PROJECT: 'Project',
  Legacy: 'Legacy',
  Environment: 'Environment',
  MetaHuman: 'MetaHuman',
  Cinematics: 'Cinematic',
};

// Epic web-helper OAuth client. The traditional launcher client
// (`34a02cf8…`) used to work for the web `/id/api/redirect` endpoint but
// Epic now rejects it with "clientId is invalid". The web helper accepts
// the same redirect flow and mints tokens that the FAB account-services
// endpoints honour.
const LAUNCHER_CLIENT_ID = 'xyza7891gCRD0RYg7IH8wgFLfPdrTMSm';
const LAUNCHER_CLIENT_SECRET = 'MYsmYFcNKRStTMR5T7CvQ8JXkY4BSTSr';

function fabSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s&,/]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
}

function fabCategoriesToTags(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];
  const tags: string[] = [];
  for (const cat of categories) {
    const name =
      typeof cat === 'string'
        ? cat
        : cat && typeof cat === 'object' && typeof (cat as { name?: string }).name === 'string'
          ? (cat as { name: string }).name
          : '';
    if (!name) continue;
    const slug = fabSlug(name);
    if (slug && !tags.includes(slug)) tags.push(slug);
  }
  return tags;
}

interface FabLibraryItem {
  title?: string;
  description?: string;
  seller?: string;
  url?: string;
  listingType?: string;
  assetId?: string;
  categories?: unknown[];
  images?: { url?: string; type?: string }[];
  projectVersions?: { engineVersions?: string[]; targetPlatforms?: string[] }[];
  customAttributes?: { ListingIdentifier?: string }[];
}

interface FabLibraryPage {
  results?: FabLibraryItem[];
  cursors?: { next?: string | null };
}

interface EpicCredentials {
  access_token: string;
  refresh_token?: string;
  account_id: string;
  displayName?: string;
}

function extractFabListingId(item: FabLibraryItem): string | null {
  if (item.customAttributes) {
    for (const attr of item.customAttributes) {
      if (attr && typeof attr === 'object' && typeof attr.ListingIdentifier === 'string') {
        return attr.ListingIdentifier;
      }
    }
  }
  return item.assetId ?? null;
}

/**
 * Thrown when the stored Epic credentials are stale (refresh failed) and no
 * interactive `promptAuthCode` was supplied — i.e. the tRPC/renderer path,
 * where reading `process.stdin` is impossible. WS5 surfaces `redirectUrl` so
 * the user can complete the auth-code flow out-of-band. The CLI never hits
 * this: it passes a `promptAuthCode` that reads stdin, preserving today's
 * behavior exactly.
 */
export class FabAuthRequiredError extends Error {
  readonly redirectUrl: string;
  constructor(redirectUrl: string) {
    super('Epic sign-in required: no saved login, or one that can no longer be refreshed.');
    this.name = 'FabAuthRequiredError';
    this.redirectUrl = redirectUrl;
  }
}

/** Where the user signs in to Epic; the page answers with an authorization code. */
export const FAB_AUTH_REDIRECT_URL = `https://www.epicgames.com/id/api/redirect?clientId=${LAUNCHER_CLIENT_ID}&responseType=code`;

const EPIC_TOKEN_URL =
  'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';

function credentialsPath(): string {
  // Lazy: `app.getPath` is only valid once the app module is loaded.
  return join(app.getPath('userData'), 'epic_credentials.json');
}

/**
 * Pull the authorization code out of whatever the user pasted. After signing
 * in, Epic shows a JSON page (`{"redirectUrl":…,"authorizationCode":"…",…}`),
 * and people paste the whole page, just the value, or the value in quotes.
 * Returns null when nothing code-shaped is there.
 */
export function parseAuthorizationCode(pasted: string): string | null {
  const text = pasted.trim();
  if (!text) return null;
  const fromJson = /"authorizationCode"\s*:\s*"([^"]+)"/.exec(text);
  if (fromJson) return fromJson[1];
  if (/"authorizationCode"\s*:\s*null/.test(text)) return null;
  const fromUrl = /[?&]code=([^&\s]+)/.exec(text);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]);
    } catch {
      return null; // A malformed %-escape is not a code.
    }
  }
  const bare = text.replace(/^["']+|["']+$/g, '');
  return /^[A-Za-z0-9_-]{8,}$/.test(bare) ? bare : null;
}

/**
 * Save the Epic login readable by this user only (0600; Windows ignores the
 * mode and relies on the profile folder's ACL). Written to a temp file and
 * renamed, so a crash never leaves half a file, and an existing file written
 * by an older build with default permissions is replaced, not reused.
 */
function writeCredentials(credsPath: string, creds: EpicCredentials): void {
  const tmp = `${credsPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    renameSync(tmp, credsPath);
  } catch (err) {
    // Don't leave live tokens in a stray temp file (Windows rename can fail
    // with EPERM/EBUSY while antivirus or the indexer holds the target).
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The saved Epic login, or null when there is none or it can't be parsed. A
 * corrupt file is treated as signed out, so the person gets the sign-in
 * prompt instead of a raw SyntaxError on every sync.
 */
function readCredentials(credsPath: string): EpicCredentials | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as EpicCredentials) : null;
  } catch {
    return null;
  }
}

export type EpicConnectResult = { ok: true; displayName?: string } | { ok: false; message: string };

/**
 * Exchange an Epic authorization code for tokens and save them where
 * `enrichFab` reads them. Shared by the CLI's stdin prompt and the
 * renderer's sign-in dialog (`fab.connect`). Never throws: a failure comes
 * back as a message a person can act on.
 */
export async function exchangeEpicAuthCode(
  code: string,
  credsPath: string = credentialsPath(),
): Promise<EpicConnectResult> {
  const basic = Buffer.from(`${LAUNCHER_CLIENT_ID}:${LAUNCHER_CLIENT_SECRET}`).toString('base64');
  let resp: Response;
  try {
    resp = await fetch(EPIC_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
    });
  } catch (e) {
    return { ok: false, message: `Could not reach Epic: ${(e as Error).message}` };
  }
  if (!resp.ok) {
    // Codes are single-use and expire within minutes; that is the usual 400.
    // Epic's body is for a log, not for the person reading the dialog.
    const body = (await resp.text().catch(() => '')).slice(0, 250);
    console.warn(`[fab] Epic token exchange failed: HTTP ${resp.status} ${body}`);
    return {
      ok: false,
      message:
        resp.status === 400
          ? 'Epic did not accept that code. Codes work once and expire after a few minutes; sign in again for a fresh one.'
          : `Epic answered HTTP ${resp.status}. Try again in a moment.`,
    };
  }
  let fresh: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    displayName?: string;
  };
  try {
    fresh = (await resp.json()) as typeof fresh;
  } catch {
    return { ok: false, message: 'Epic answered with something that is not a login.' };
  }
  if (!fresh.access_token || !fresh.account_id) {
    return { ok: false, message: 'Epic answered without an access token or account id.' };
  }
  const creds: EpicCredentials = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    account_id: fresh.account_id,
    ...(fresh.displayName ? { displayName: fresh.displayName } : {}),
  };
  try {
    writeCredentials(credsPath, creds);
  } catch (e) {
    return {
      ok: false,
      message: `Signed in, but the login could not be saved: ${(e as Error).message}`,
    };
  }
  return { ok: true, displayName: fresh.displayName };
}

export interface EnrichFabOptions {
  /** Bearer token override (replaces the CLI `--fab-token` flag). */
  fabToken?: string;
  /** Account-id override (replaces the CLI `--fab-account` flag). */
  fabAccount?: string;
  /** Direct progress sink (testable). Defaults to the shared `progressBus`. */
  onProgress?: (p: ActionProgress) => void;
  /**
   * Headless boundary: interactive auth-code re-auth cannot run from the
   * renderer. The CLI passes a function that reads stdin; tRPC omits it, so a
   * failed refresh throws `FabAuthRequiredError` instead of hanging. Receives
   * the Epic redirect URL and resolves the pasted `authorizationCode`.
   */
  promptAuthCode?: (redirectUrl: string) => Promise<string>;
}

export interface EnrichFabResult {
  libraryItems: number;
  updated: number;
  unmatched: number;
  reauthRequired?: boolean;
  /**
   * Epic re-auth redirect URL, set only alongside `reauthRequired` on the tRPC
   * path. The `fab.enrich` router catches `FabAuthRequiredError` and folds it
   * into this result rather than throwing, because electron-trpc's v11 error
   * fallback drops custom error `data` — so the URL can't ride the error channel.
   */
  redirectUrl?: string;
  /**
   * Set when the library could not be fetched in full (HTTP or network error,
   * or re-auth failed). Nothing was enriched in that case. Carried in the
   * result because electron-trpc drops custom error data.
   */
  fetchError?: string;
}

export async function enrichFab(opts: EnrichFabOptions = {}): Promise<EnrichFabResult> {
  const emit = opts.onProgress ?? emitProgress;
  const pathMod = await import('node:path');
  const credsPath = pathMod.join(app.getPath('userData'), 'epic_credentials.json');

  // Token/account overrides arrive as options now (the CLI parses the
  // `--fab-token`/`--fab-account` flags and passes them in). Useful when the
  // OAuth flow can't refresh (Epic's public clients reject /id/api/redirect as
  // of 2026-04-25). When both are provided and no creds file exists, we use
  // them for this run and skip the refresh/auth-code flow entirely.
  const overrideToken = opts.fabToken;
  const overrideAccount = opts.fabAccount;

  let creds: EpicCredentials;
  const saved = readCredentials(credsPath);
  if (saved) {
    creds = saved;
  } else if (overrideToken && overrideAccount) {
    creds = { access_token: overrideToken, account_id: overrideAccount };
  } else if (opts.promptAuthCode) {
    // First run from the CLI: sign in now instead of printing instructions.
    const code = parseAuthorizationCode(await opts.promptAuthCode(FAB_AUTH_REDIRECT_URL));
    const connected = code ? await exchangeEpicAuthCode(code, credsPath) : null;
    if (!connected?.ok) {
      throw new Error(
        `[fab] not signed in to Epic: ${connected ? connected.message : 'no authorization code was entered'}`,
      );
    }
    const fresh = readCredentials(credsPath);
    if (!fresh) throw new Error('[fab] Epic login was saved but could not be read back');
    creds = fresh;
  } else {
    // Never signed in. The renderer offers the same sign-in as for a stale
    // login, so this is not an error it has to explain.
    throw new FabAuthRequiredError(FAB_AUTH_REDIRECT_URL);
  }
  if (overrideToken) creds.access_token = overrideToken;
  if (overrideAccount) creds.account_id = overrideAccount;
  if (!creds.access_token || !creds.account_id) {
    throw new Error('[fab] credentials missing access_token or account_id');
  }

  const refreshAccessToken = async (): Promise<boolean> => {
    if (!creds.refresh_token) return false;
    const basic = Buffer.from(`${LAUNCHER_CLIENT_ID}:${LAUNCHER_CLIENT_SECRET}`).toString('base64');
    try {
      const resp = await fetch(
        'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refresh_token)}`,
        },
      );
      if (!resp.ok) {
        const body = await resp.text();
        emit({
          action: 'enrich-fab',
          phase: 'progress',
          processed: 0,
          total: 0,
          currentName: null,
          message: `token refresh failed: HTTP ${resp.status} ${body.slice(0, 200)}`,
        });
        return false;
      }
      const fresh = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        account_id: string;
      };
      creds.access_token = fresh.access_token;
      if (fresh.refresh_token) creds.refresh_token = fresh.refresh_token;
      if (fresh.account_id) creds.account_id = fresh.account_id;
      writeCredentials(credsPath, creds);
      return true;
    } catch (e) {
      emit({
        action: 'enrich-fab',
        phase: 'progress',
        processed: 0,
        total: 0,
        currentName: null,
        message: `token refresh network error: ${(e as Error).message}`,
      });
      return false;
    }
  };

  /**
   * Epic Games OAuth authorization-code flow. Epic disallows device-code on
   * the launcher client but accepts authorization codes minted via the web
   * redirect endpoint. The interactive input is provided by the injected
   * `promptAuthCode` callback (CLI: stdin). When no callback is supplied
   * (tRPC), this throws `FabAuthRequiredError` carrying the redirect URL.
   */
  const runEpicAuthCodeFlow = async (): Promise<boolean> => {
    if (!opts.promptAuthCode) {
      // Close the run that 'start' opened, or the UI keeps the sync busy.
      emit({
        action: 'enrich-fab',
        phase: 'error',
        processed: items.length,
        total: 0,
        currentName: null,
        message: 'Epic sign-in required',
      });
      throw new FabAuthRequiredError(FAB_AUTH_REDIRECT_URL);
    }
    const code = parseAuthorizationCode(await opts.promptAuthCode(FAB_AUTH_REDIRECT_URL));
    if (!code) {
      emit({
        action: 'enrich-fab',
        phase: 'progress',
        processed: 0,
        total: 0,
        currentName: null,
        message: 'empty authorization code',
      });
      return false;
    }
    const connected = await exchangeEpicAuthCode(code, credsPath);
    if (!connected.ok) {
      emit({
        action: 'enrich-fab',
        phase: 'progress',
        processed: 0,
        total: 0,
        currentName: null,
        message: `token exchange failed: ${connected.message}`,
      });
      return false;
    }
    const fresh = readCredentials(credsPath);
    if (!fresh) return false;
    creds = fresh;
    return true;
  };

  const base = `https://www.fab.com/e/accounts/${creds.account_id}/ue/library`;
  const items: FabLibraryItem[] = [];
  let cursor: string | null = null;
  let page = 0;
  let refreshTried = false;
  let authCodeTried = false;

  // A partial library must never be enriched from: report the failure and stop.
  const failFetch = (message: string): EnrichFabResult => {
    emit({
      action: 'enrich-fab',
      phase: 'error',
      processed: items.length,
      total: 0,
      currentName: null,
      message,
    });
    return { libraryItems: items.length, updated: 0, unmatched: 0, fetchError: message };
  };

  emit({
    action: 'enrich-fab',
    phase: 'start',
    processed: 0,
    total: 0,
    currentName: null,
    message: `fetching library for account ${creds.account_id.slice(0, 8)}…`,
  });

  while (true) {
    const url = `${base}?count=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { Authorization: `Bearer ${creds.access_token}` } });
    } catch (e) {
      return failFetch(`network error on page ${page + 1}: ${(e as Error).message}`);
    }
    if (resp.status === 401) {
      // Token expired (possibly mid-pagination): refresh once per expiry, then
      // fall back to the authorization-code re-auth. In the tRPC path (no
      // promptAuthCode) the latter throws FabAuthRequiredError.
      if (!refreshTried) {
        refreshTried = true;
        if (await refreshAccessToken()) continue; // retry same page with new token
      }
      if (!authCodeTried) {
        authCodeTried = true;
        if (await runEpicAuthCodeFlow()) continue;
      }
      return failFetch('re-auth failed; aborting');
    }
    if (!resp.ok) {
      const body = await resp.text();
      return failFetch(`HTTP ${resp.status} on page ${page + 1}: ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as FabLibraryPage;
    const results = data.results ?? [];
    items.push(...results);
    page += 1;
    // A good page means the token works; allow one more refresh if it expires later.
    refreshTried = false;
    authCodeTried = false;
    emit({
      action: 'enrich-fab',
      phase: 'progress',
      processed: items.length,
      total: 0,
      currentName: null,
      message: `page ${page}: ${results.length} items (total ${items.length})`,
    });
    cursor = data.cursors?.next ?? null;
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (items.length === 0) {
    emit({
      action: 'enrich-fab',
      phase: 'done',
      processed: 0,
      total: 0,
      currentName: null,
      updated: 0,
      unmatched: 0,
      message: 'library fetch complete: 0 item(s)',
    });
    return { libraryItems: 0, updated: 0, unmatched: 0 };
  }

  // Build title + assetId lookups so we can match Omnidex assets either way.
  const byTitle = new Map<string, FabLibraryItem>();
  const byAssetId = new Map<string, FabLibraryItem>();
  for (const item of items) {
    const t = (item.title ?? '').trim();
    if (t && !byTitle.has(t)) byTitle.set(t, item);
    // Stored fab_item_id prefers ListingIdentifier (extractFabListingId), so
    // index under both ids or an item carrying both is never rematched.
    for (const aid of [item.assetId, extractFabListingId(item)]) {
      if (aid && !byAssetId.has(aid)) byAssetId.set(aid, item);
    }
  }

  const db = openDatabase();
  // Match against EVERY asset (not just fab_owned) — any asset whose name or
  // orbital_title equals a FAB library title gets enriched and flagged
  // fab_owned.
  const candidateRows = db
    .prepare(
      `SELECT id, name, orbital_title, fab_item_id FROM assets
       WHERE content_format IS NULL AND scan_location_id > 0`,
    )
    .all() as {
    id: number;
    name: string;
    orbital_title: string | null;
    fab_item_id: string | null;
  }[];

  const updateStmt = db.prepare(
    `UPDATE assets SET
       fab_owned = 1,
       fab_item_id = ?,
       asset_type = ?,
       orbital_title = COALESCE(?, orbital_title),
       orbital_description = ?,
       orbital_seller_name = ?,
       orbital_thumbnail_url = ?,
       orbital_source_url = ?,
       orbital_supported_versions = ?,
       orbital_categories = ?,
       orbital_last_checked_timestamp = ?,
       tags = COALESCE(?, tags)
     WHERE id = ?`,
  );

  let updated = 0;
  let unmatched = 0;
  let processedRows = 0;
  const now = new Date().toISOString();

  for (const row of candidateRows) {
    processedRows += 1;
    // Emit loop-position progress every 100 rows so the bar tracks the whole
    // sweep, not just the matched subset — a mostly-unmatched library would
    // otherwise leave the bar stuck near 0 while the loop is nearly done. The
    // item isn't resolved this early, so the message carries the match tally.
    if (processedRows % 100 === 0) {
      emit({
        action: 'enrich-fab',
        phase: 'progress',
        processed: processedRows,
        total: candidateRows.length,
        currentName: null,
        updated,
        message: `processed ${processedRows}/${candidateRows.length} (matched ${updated})`,
      });
    }
    let item: FabLibraryItem | undefined;
    if (row.fab_item_id && byAssetId.has(row.fab_item_id)) {
      item = byAssetId.get(row.fab_item_id);
    } else {
      const candidates = [row.orbital_title, row.name].filter((s): s is string => !!s);
      for (const t of candidates) {
        item = byTitle.get(t.trim());
        if (item) break;
      }
    }
    if (!item) {
      unmatched += 1;
      continue;
    }

    // Engine versions across all projectVersions, deduped.
    const engineVersions: string[] = [];
    for (const pv of item.projectVersions ?? []) {
      for (const ev of pv.engineVersions ?? []) {
        if (!engineVersions.includes(ev)) engineVersions.push(ev);
      }
    }
    const categories = (item.categories ?? [])
      .map((c) =>
        typeof c === 'string'
          ? c
          : c && typeof c === 'object' && typeof (c as { name?: string }).name === 'string'
            ? (c as { name: string }).name
            : '',
      )
      .filter((s) => s.length > 0);
    const tags = fabCategoriesToTags(item.categories);
    // Prefer the "Featured" image, fall back to first.
    let thumbnailUrl: string | null = null;
    for (const img of item.images ?? []) {
      if (
        img &&
        typeof img === 'object' &&
        img.type === 'Featured' &&
        typeof img.url === 'string'
      ) {
        thumbnailUrl = img.url;
        break;
      }
    }
    if (!thumbnailUrl) {
      const first = item.images?.[0];
      if (first && typeof first === 'object' && typeof first.url === 'string') {
        thumbnailUrl = first.url;
      }
    }
    const listingType = item.listingType ?? '';
    const assetType = FAB_LISTING_TYPE_MAP[listingType] ?? (listingType || 'Asset');
    const fabId = extractFabListingId(item);

    updateStmt.run(
      fabId,
      assetType,
      item.title ?? null,
      item.description ?? null,
      item.seller ?? null,
      thumbnailUrl,
      item.url ?? null,
      engineVersions.length > 0 ? JSON.stringify(engineVersions) : null,
      categories.length > 0 ? JSON.stringify(categories) : null,
      now,
      tags.length > 0 ? JSON.stringify(tags) : null,
      row.id,
    );
    updated += 1;
  }

  emit({
    action: 'enrich-fab',
    phase: 'done',
    processed: candidateRows.length,
    total: candidateRows.length,
    currentName: null,
    updated,
    unmatched,
    message: `complete — matched/updated=${updated} unmatched=${unmatched}`,
  });

  return { libraryItems: items.length, updated, unmatched };
}
