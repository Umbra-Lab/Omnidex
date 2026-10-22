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
    super('Epic re-authorization required: stored credentials are stale.');
    this.name = 'FabAuthRequiredError';
    this.redirectUrl = redirectUrl;
  }
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
}

export async function enrichFab(opts: EnrichFabOptions = {}): Promise<EnrichFabResult> {
  const emit = opts.onProgress ?? emitProgress;
  const fsMod = await import('node:fs');
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
  if (fsMod.existsSync(credsPath)) {
    creds = JSON.parse(fsMod.readFileSync(credsPath, 'utf8')) as EpicCredentials;
  } else if (overrideToken && overrideAccount) {
    creds = { access_token: overrideToken, account_id: overrideAccount };
  } else {
    throw new Error(
      `[fab] no credentials at ${credsPath} and no fabToken/fabAccount provided. Either:\n` +
        `  - Drop a JSON with { access_token, refresh_token, account_id } at the path above, OR\n` +
        `  - Re-run with: pnpm enrich-fab --fab-token <bearer> --fab-account <id>`,
    );
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
      fsMod.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
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
    const redirectUrl = `https://www.epicgames.com/id/api/redirect?clientId=${LAUNCHER_CLIENT_ID}&responseType=code`;
    if (!opts.promptAuthCode) {
      throw new FabAuthRequiredError(redirectUrl);
    }
    const code = (await opts.promptAuthCode(redirectUrl)).trim().replace(/^"+|"+$/g, '');
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
    const basic = Buffer.from(`${LAUNCHER_CLIENT_ID}:${LAUNCHER_CLIENT_SECRET}`).toString('base64');
    const tokenUrl =
      'https://account-public-service-prod.ol.epicgames.com/account/api/oauth/token';
    try {
      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=authorization_code&code=${encodeURIComponent(code)}`,
      });
      if (!resp.ok) {
        emit({
          action: 'enrich-fab',
          phase: 'progress',
          processed: 0,
          total: 0,
          currentName: null,
          message: `token exchange failed: HTTP ${resp.status} ${(await resp.text()).slice(0, 250)}`,
        });
        return false;
      }
      const fresh = (await resp.json()) as {
        access_token: string;
        refresh_token: string;
        account_id: string;
        displayName?: string;
      };
      creds.access_token = fresh.access_token;
      creds.refresh_token = fresh.refresh_token;
      creds.account_id = fresh.account_id;
      if (fresh.displayName) creds.displayName = fresh.displayName;
      fsMod.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
      return true;
    } catch (e) {
      emit({
        action: 'enrich-fab',
        phase: 'progress',
        processed: 0,
        total: 0,
        currentName: null,
        message: `token exchange network error: ${(e as Error).message}`,
      });
      return false;
    }
  };

  const base = `https://www.fab.com/e/accounts/${creds.account_id}/ue/library`;
  const items: FabLibraryItem[] = [];
  let cursor: string | null = null;
  let page = 0;
  let refreshTried = false;

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
      emit({
        action: 'enrich-fab',
        phase: 'error',
        processed: items.length,
        total: 0,
        currentName: null,
        message: `network error on page ${page + 1}: ${(e as Error).message}`,
      });
      break;
    }
    if (resp.status === 401 && !refreshTried) {
      refreshTried = true;
      if (await refreshAccessToken()) {
        continue; // retry same page with new token
      }
      // refresh failed — fall back to the authorization-code re-auth. In the
      // tRPC path (no promptAuthCode) this throws FabAuthRequiredError.
      const ok = await runEpicAuthCodeFlow();
      if (ok) continue;
      emit({
        action: 'enrich-fab',
        phase: 'error',
        processed: items.length,
        total: 0,
        currentName: null,
        message: 're-auth failed; aborting',
      });
      break;
    }
    if (!resp.ok) {
      const body = await resp.text();
      emit({
        action: 'enrich-fab',
        phase: 'error',
        processed: items.length,
        total: 0,
        currentName: null,
        message: `HTTP ${resp.status} on page ${page + 1}: ${body.slice(0, 200)}`,
      });
      break;
    }
    const data = (await resp.json()) as FabLibraryPage;
    const results = data.results ?? [];
    items.push(...results);
    page += 1;
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
    const aid = item.assetId ?? extractFabListingId(item) ?? '';
    if (aid && !byAssetId.has(aid)) byAssetId.set(aid, item);
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
      if (img && typeof img === 'object' && img.type === 'Featured' && typeof img.url === 'string') {
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
    const assetType = FAB_LISTING_TYPE_MAP[listingType] ?? listingType ?? 'Asset';
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
