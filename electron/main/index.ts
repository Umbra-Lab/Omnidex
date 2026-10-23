import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL, pathToFileURL } from 'node:url';
import { extractThumbnail } from '@omnidex/uasset';
import { app, BrowserWindow, dialog, net, protocol, session, shell } from 'electron';
import { createIPCHandler } from 'electron-trpc/main';
import { installAppMenu } from './app-menu';
import { decodeAssetPath, isPathAllowed, parseRangeHeader } from './asset-protocol';
import {
  installChildProcessHandlers,
  installCrashHandlers,
  startCrashReporter,
} from './crash-recovery';
import { closeDatabase, openDatabase } from './db';
import { thumbnailsDir } from './db/paths';
import { enrichFab, FabAuthRequiredError } from './fab/enrich';
import { registerCredentialsIpc } from './ipc/credentials';
import { registerDialogIpc } from './ipc/dialog';
import { registerFabIpc } from './ipc/fab';
import { registerMenuIpc } from './ipc/menu';
import { registerOrbitalIpc } from './ipc/orbital';
import { registerScannerIpc } from './ipc/scanner';
import { registerShellIpc } from './ipc/shell';
import { registerUassetIpc } from './ipc/uasset';
import { initLogger } from './logger';
import { registerGlobalHotkeys } from './native/hotkeys';
import { registerNotificationIpc } from './native/notifications';
import { enrichOrbital } from './orbital/enrich';
import { type ActionProgress, progressBus } from './progress/bus';
import { refreshAllScans } from './scanner/refresh-all';
import { findThumbnailSource } from './scanner/thumbnail-finder';
import { appRouter } from './trpc/router';
import { initAutoUpdater } from './updater';
import { getWindowBounds, manageWindowState } from './window-state';

// CLI modes: side jobs that share the main bundle's boot path (DB open,
// migrations, IPC registration) and exit when done. Each skips createWindow.
const REFRESH_SCANS = process.argv.includes('--refresh-scans');
const EXTRACT_THUMBS = process.argv.includes('--extract-missing-thumbs');
const ENRICH_ORBITAL = process.argv.includes('--enrich-orbital');
const ENRICH_FAB = process.argv.includes('--enrich-fab');
const BACKFILL_COURSE_SOURCES = process.argv.includes('--backfill-course-sources');
const INJECT_GALLERY_FIXTURE = process.argv.includes('--inject-gallery-fixture');
const REVERT_GALLERY_FIXTURE = process.argv.includes('--revert-gallery-fixture');

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Pin the app name BEFORE any code reads `app.getPath('userData')`.
// `electron <script.mjs>` (Playwright launch path) doesn't auto-load
// package.json, so app.getName() falls back to "Electron" and userData
// goes to %APPDATA%/Electron/ — a separate DB from the packaged app's
// %APPDATA%/omnidex/. Pinning the name here makes every launch mode
// (packaged / `electron .` / `electron out/main/index.mjs`) hit the
// same userData root.
app.setName('omnidex');

// Persistent logging: patch console.* to mirror into a rotating file under
// app.getPath('logs') so diagnostics survive a quit/crash and a user can send
// them. Must run AFTER app.setName (logs dir is derived from the app name) and
// BEFORE any console.* diagnostics below, including the crash handlers.
initLogger();

// Local crash reporting (minidumps, no upload). Started before app-ready so
// crashes during startup are captured too.
startCrashReporter();

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;

// Global last-resort crash handlers. Without these, a stray rejection (e.g.
// from the detached background-thumbnail job) or an uncaught exception
// silently tears the process down with no diagnostics. Log it, and if a
// window is up, show a NON-fatal error dialog so the app keeps running
// instead of vanishing. We deliberately do not re-throw / quit here.
function reportNonFatal(scope: string, err: unknown): void {
  const e =
    err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  console.error(`[omnidex] ${scope}:`, e);
  if (mainWindow && !mainWindow.isDestroyed()) {
    dialog.showErrorBox(
      'Omnidex — Unexpected error',
      `Something went wrong but Omnidex is still running.\n\n${scope}: ${e.message}`,
    );
  }
}

process.on('uncaughtException', (err) => {
  reportNonFatal('Uncaught exception', err);
});

process.on('unhandledRejection', (reason) => {
  reportNonFatal('Unhandled promise rejection', reason);
});

// ---------------------------------------------------------------------------
// Security: omnidex-asset:// allowlist
// ---------------------------------------------------------------------------
// The omnidex-asset:// handler is an arbitrary-file-read primitive: a renderer
// injection could otherwise request `omnidex-asset:///etc/passwd` or a path to
// `~/.ssh/id_rsa` and the handler would happily stream the bytes back. We
// contain it to an ALLOWLIST of roots:
//   - app.getPath('userData')  (covers the thumbnails dir we cache into)
//   - each ACTIVE, real-filesystem scan_location path from the DB
// The FAB sentinel row (id = -1, path 'FAB:VaultCache') is intentionally
// excluded: it is not a real path, so realpathSync throws and we skip it.
//
// Roots are cached in-process (resolving + realpath'ing per request is wasteful)
// but the cache is invalidated on a MISS so scan-location changes are picked up
// without restarting: if a candidate isn't under any cached root we rebuild the
// allowlist once and re-check before rejecting.
let allowedRootsCache: string[] | null = null;

function buildAllowedRoots(): string[] {
  const roots = new Set<string>();
  // userData is always allowed (thumbnails live under it).
  try {
    roots.add(realpathSync(app.getPath('userData')));
  } catch {
    // userData should always exist post-boot; if realpath fails fall back to
    // the plain path so thumbnails still resolve.
    roots.add(app.getPath('userData'));
  }
  // Active filesystem scan locations. Mirror the refresh query: id > 0 skips
  // the FAB sentinel, is_active = 1 skips disabled roots. realpath each so a
  // symlinked scan root still matches files resolved through it.
  try {
    const db = openDatabase();
    const rows = db
      .prepare('SELECT path FROM scan_locations WHERE id > 0 AND is_active = 1')
      .all() as { path: string }[];
    for (const { path } of rows) {
      if (!path) continue;
      try {
        roots.add(realpathSync(path));
      } catch {
        // Path no longer on disk / not a real path (e.g. the FAB sentinel if a
        // future row reuses a positive id). Skip — never widen the allowlist.
      }
    }
  } catch (err) {
    // DB unavailable: keep userData-only containment rather than failing open.
    console.error('[omnidex] asset allowlist: failed to read scan_locations:', err);
  }
  return [...roots];
}

function getAllowedRoots(forceRefresh = false): string[] {
  if (forceRefresh || !allowedRootsCache) {
    allowedRootsCache = buildAllowedRoots();
  }
  return allowedRootsCache;
}

/**
 * Resolve a decoded asset path to its realpath and verify it is contained
 * within the allowlist. Returns the realpath on success, or `null` if the
 * path escapes (via `..`, a symlink, or simply living outside every root).
 * Never throws — callers turn `null` into a 403.
 */
function resolveContainedAssetPath(decodedPath: string): string | null {
  let real: string;
  try {
    // realpathSync collapses `..` AND follows symlinks, so a symlink inside an
    // allowed dir that points at /etc/passwd resolves to /etc/passwd here and
    // is then rejected by the containment check below.
    real = realpathSync(decodedPath);
  } catch {
    return null; // missing file / broken symlink / bad path
  }
  if (isPathAllowed(real, getAllowedRoots())) return real;
  // Cache miss: a scan location may have been added since we last built the
  // allowlist. Rebuild once and re-check before rejecting.
  if (isPathAllowed(real, getAllowedRoots(true))) return real;
  return null;
}

// ---------------------------------------------------------------------------
// Security: Content-Security-Policy (response header, not a meta tag)
// ---------------------------------------------------------------------------
// Applied only to the packaged file:// load (see installSecurityHandlers): the
// electron-vite dev server / HMR needs 'unsafe-eval' + 'unsafe-inline' for
// script, which we must NOT ship in production. Each directive:
//   default-src 'self'          — deny everything not explicitly allowed below.
//   script-src 'self'           — only our bundled JS; no inline/eval in prod.
//   style-src 'self' 'unsafe-inline'
//                               — Tailwind/Radix inject inline <style>/style=""
//                                 attributes at runtime, so inline styles are
//                                 required. (UNSURE — see notes; verify nothing
//                                 needs a style CDN.)
//   img-src 'self' omnidex-asset: https: data:
//                               — local bundle assets, our custom asset scheme
//                                 for on-disk thumbnails, remote Fab/Orbital CDN
//                                 thumbnails (arbitrary https hosts like
//                                 media.fab.com), and inline data: URIs.
//   font-src 'self' data:       — bundled + inlined (base64) fonts.
//   connect-src 'self'          — renderer talks to main over IPC (electron-trpc),
//                                 not the network; no remote XHR/fetch/WS.
//   object-src 'none'           — no <object>/<embed>/<applet> plugins.
//   frame-src 'none'            — no nested browsing contexts.
//   base-uri 'none'             — block <base> tag href hijacking of relative URLs.
const PACKAGED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' omnidex-asset: https: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * Allow only web-safe schemes to leave the app. Local-program launchers
 * (file:, smb:, vscode:, etc.) are a credential-leak / arbitrary-launch vector
 * — including zero-click via window.open — so everything outside this set is
 * denied and logged.
 */
function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol: scheme } = new NodeURL(rawUrl);
    return scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:';
  } catch {
    return false;
  }
}

/**
 * Wire the strict CSP header (packaged only) and navigation guards onto the
 * default session / a window's webContents. Called once per window after
 * createWindow, plus a session-level CSP hook installed once at app-ready.
 */
function installSecurityHandlers(win: BrowserWindow): void {
  const contents = win.webContents;

  // Navigation guard: the SPA is hash-routed, so a top-level navigation away
  // from the dev URL (dev) or the file:// bundle (prod) is never legitimate —
  // block it. Covers in-page links, JS-driven location changes, and frames.
  const allowNavigation = (targetUrl: string): boolean => {
    const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    if (devUrl && targetUrl.startsWith(devUrl)) return true;
    if (targetUrl.startsWith('file://')) return true;
    return false;
  };
  const guard = (event: { preventDefault: () => void }, targetUrl: string): void => {
    if (!allowNavigation(targetUrl)) {
      console.warn(`[omnidex] blocked navigation to: ${targetUrl}`);
      event.preventDefault();
    }
  };
  contents.on('will-navigate', (event, url) => guard(event, url));
  // will-frame-navigate catches sub-frame navigations the top-level
  // will-navigate misses. Its listener gets a single event object whose `url`
  // is the navigation target.
  contents.on('will-frame-navigate', (details) => guard(details, details.url));
  contents.on('will-attach-webview', (event) => {
    // No <webview> is used anywhere; refuse to attach one outright.
    console.warn('[omnidex] blocked <webview> attach');
    event.preventDefault();
  });

  // Window-open allowlist: route http/https/mailto to the OS browser, deny the
  // window itself, and refuse every other scheme (file:, smb:, vscode:, …).
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    } else {
      console.warn(`[omnidex] blocked window.open to disallowed scheme: ${url}`);
    }
    return { action: 'deny' };
  });
}

function createWindow(): void {
  // macOS floats its native traffic lights over our own chrome. `hiddenInset`
  // hides the OS title bar so the React chrome runs edge-to-edge while keeping
  // the window controls; `trafficLightPosition` centers the lights in the 44px
  // (h-11) NavBar, which is the topmost strip now. NavBar renders a 68px
  // spacer on darwin so the first nav item clears them. Windows and Linux keep
  // the native frame + `autoHideMenuBar`, which is why the nav prints no
  // wordmark — the OS caption already says "Omnidex" one strip above.
  //
  // This used to reference a React TitleBar at h-8; that component rendered
  // two visible chrome strips, was unmounted, and is now deleted.
  const macChrome =
    process.platform === 'darwin'
      ? ({
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 13, y: 10 },
        } as const)
      : {};

  // Restore the persisted size/position (clamped to a visible display); falls
  // back to the historical 1280×800 on first launch / corrupt state. Maximized
  // state is re-applied below via manageWindowState (post-construction).
  const { width, height, x, y } = getWindowBounds();

  mainWindow = new BrowserWindow({
    width,
    height,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
    minWidth: 1024,
    minHeight: 768,
    backgroundColor: '#0f1419',
    show: false,
    autoHideMenuBar: true,
    ...macChrome,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Persist size/position/maximized on resize/move/maximize and re-apply the
  // saved maximized state. Keep show gated on ready-to-show so the restored
  // (and possibly maximized) geometry is in place before the window paints.
  manageWindowState(mainWindow);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // Electron process-death recovery for this window (render-process-gone /
  // unresponsive) — distinct from the JS-level handlers above. Logs the event
  // through the file logger and offers a reload.
  installCrashHandlers(mainWindow);

  // Mirror renderer console to the main-process terminal during dev so
  // bridge/runtime-detection issues surface without opening devtools.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const tag = ['debug', 'info', 'warn', 'error'][level] ?? 'info';
      const src = sourceId ? ` ${sourceId}:${line}` : '';
      console.log(`[renderer:${tag}]${src} ${message}`);
    });
  }

  // Navigation guard + window-open allowlist for this window.
  installSecurityHandlers(mainWindow);

  // Dev-server load + DevTools are gated on `!app.isPackaged`, NOT on the env
  // var: a packaged build that happened to inherit ELECTRON_RENDERER_URL would
  // otherwise load a remote dev server and pop DevTools. Packaged builds always
  // load the local file:// bundle and never auto-open DevTools.
  const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer-react/index.html'));
  }
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Register custom `omnidex-asset://` scheme BEFORE app is ready so it can
// stream local files (thumbnails, audio previews, doc files) past the
// default-file:// CSP restriction.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'omnidex-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);

app.whenReady().then(() => {
  // The renderer calls `omnidex-asset://<encoded-absolute-path>` — decode
  // and stream from disk via `net.fetch`. Replaces Tauri's `convertFileSrc`
  // + its `asset:` protocol handler.
  protocol.handle('omnidex-asset', async (request) => {
    try {
      // Decode back to the absolute path the preload `fileUrl` encoded. On
      // macOS/Linux the leading `/` MUST be preserved (an absolute root);
      // only Windows strips the slash sitting before the `/X:` drive letter.
      // See electron/main/asset-protocol.ts for the full encode/decode story.
      const normalized = decodeAssetPath(request.url);
      // Containment: realpath + allowlist check. Rejects `..` escapes, symlinks
      // pointing outside, and any path outside userData / active scan roots.
      // Return 403 (not a throw) so an injection can't probe the filesystem by
      // distinguishing "missing" (404) from "forbidden".
      const contained = resolveContainedAssetPath(normalized);
      if (!contained) {
        console.warn(`[omnidex] asset request rejected (outside allowlist): ${normalized}`);
        return new Response('Forbidden', { status: 403 });
      }
      const fileUrl = pathToFileURL(contained).toString();
      // Forward the request headers, `Range` above all: `net.fetch` on a
      // file:// URL honours it and returns exactly the requested bytes.
      const upstream = await net.fetch(fileUrl, { headers: request.headers });

      // ...but it answers 200 with no `Content-Range` and no `Accept-Ranges`,
      // and Chromium's media stack will not build a seekable range out of an
      // unlabelled 200. So `video.seekable` stayed empty for every course
      // video: no scrubbing, and Learn's resume-at-12:24 silently restarted
      // the lesson because assigning `currentTime` landed at 0. The bytes were
      // always right; only the envelope was missing.
      const size = statSync(contained).size;
      const range = parseRangeHeader(request.headers.get('Range'), size);

      if (range === 'unsatisfiable') {
        // 416 must carry the real length so the client can retry sensibly.
        return new Response(null, {
          status: 416,
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${size}` },
        });
      }

      const headers = new Headers(upstream.headers);
      // Advertised on every response, not just partial ones — it is how a
      // media element learns that seeking is available at all.
      headers.set('Accept-Ranges', 'bytes');

      if (!range) {
        headers.set('Content-Length', String(size));
        return new Response(upstream.body, { status: 200, headers });
      }

      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
      return new Response(upstream.body, { status: 206, headers });
    } catch (err) {
      return new Response(`Not found: ${(err as Error).message}`, { status: 404 });
    }
  });

  // Inject the strict CSP as a RESPONSE HEADER (not a meta tag) — but only for
  // the packaged file:// load. The dev server / HMR needs 'unsafe-eval' +
  // 'unsafe-inline' which we must never ship, so in dev we leave headers
  // untouched and let electron-vite serve its own permissive policy.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PACKAGED_CSP],
        },
      });
    });
  }

  // Native application menu (role-based: Cmd/Ctrl+Q/W/C/V/A, minimize, zoom,
  // fullscreen all wired by the OS). Installed once at ready.
  installAppMenu(() => mainWindow);

  // App-level child-process death recovery (GPU / utility process crashes) —
  // the window-scoped render-process-gone handler is installed in createWindow.
  installChildProcessHandlers();

  // Boot DB-open guard. A corrupt/locked DB or a single bad migration would
  // otherwise be a silent failure-to-launch (no window, process just exits).
  // The DB layer throws a typed `MigrationError` (shape below) carrying the
  // failed-migration name and the pre-migration backup path; surface whatever
  // it gives us in a dialog that NAMES the failure, then quit cleanly.
  try {
    const db = openDatabase();
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM _omnidex_migrations').get() as {
      n: number;
    };
    console.log(`[omnidex] db ready at ${db.name} — ${n} migrations applied`);
  } catch (err) {
    const e = err as Error & { migrationName?: string; backupPath?: string };
    console.error('[omnidex] failed to open database on boot:', e);
    const detailLines = [
      e.migrationName
        ? `The database failed while applying migration "${e.migrationName}".`
        : 'The database could not be opened. It may be corrupt, locked by another process, or from an incompatible version.',
      e.backupPath
        ? `A backup taken before this attempt is at:\n${e.backupPath}`
        : 'No pre-migration backup was found.',
      '',
      e.message,
    ];
    dialog.showErrorBox(
      'Omnidex — Database error',
      `Omnidex can't start because its database failed to open.\n\n${detailLines.join('\n')}`,
    );
    app.quit();
    return;
  }

  registerScannerIpc();
  registerUassetIpc();
  registerOrbitalIpc();
  registerFabIpc();
  registerShellIpc();
  registerDialogIpc();
  registerCredentialsIpc();
  registerMenuIpc();
  registerNotificationIpc();

  if (REFRESH_SCANS) {
    void runRefreshAndQuit();
    return;
  }
  if (EXTRACT_THUMBS) {
    void runExtractMissingThumbsAndQuit();
    return;
  }
  if (ENRICH_ORBITAL) {
    void runEnrichOrbitalAndQuit();
    return;
  }
  if (ENRICH_FAB) {
    void runEnrichFabAndQuit();
    return;
  }
  if (BACKFILL_COURSE_SOURCES) {
    void runBackfillCourseSourcesAndQuit();
    return;
  }
  if (INJECT_GALLERY_FIXTURE || REVERT_GALLERY_FIXTURE) {
    void runGalleryFixtureAndQuit(REVERT_GALLERY_FIXTURE);
    return;
  }
  if (process.argv.includes('--check-fixture')) {
    const db2 = openDatabase();
    const row = db2
      .prepare(
        'SELECT id, name, length(orbital_gallery_images) as gl, thumbnail_path FROM assets WHERE id = 19',
      )
      .get();
    console.log('[check-fixture] id=19 →', JSON.stringify(row));
    const galleryRow = db2
      .prepare(
        "SELECT id FROM assets WHERE orbital_gallery_images LIKE '%__omnidex_test_fixture__%' LIMIT 1",
      )
      .get();
    console.log('[check-fixture] fixture row exists:', JSON.stringify(galleryRow));
    app.exit(0);
    return;
  }

  createWindow();
  registerGlobalHotkeys(() => mainWindow);

  // electron-trpc attaches a BrowserWindow-scoped IPC router. The React
  // renderer calls through `ipcLink()` in renderer-react/src/ipc/trpc.ts.
  if (mainWindow) {
    createIPCHandler({ router: appRouter, windows: [mainWindow] });
  }

  initAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  closeDatabase();
});

// Test fixture: injects/clears a known multi-image orbital_gallery_images
// value on a stable asset id so the inspector gallery-nav Playwright test
// can run end-to-end against this DB. Production data is untouched
// (the row picked is the lowest-id asset with a real local thumbnail).
async function runGalleryFixtureAndQuit(revert: boolean): Promise<void> {
  const FIXTURE_TAG = '__omnidex_test_fixture__';
  const db = openDatabase();
  if (revert) {
    const r = db
      .prepare(
        'UPDATE assets SET orbital_gallery_images = NULL WHERE orbital_gallery_images LIKE ?',
      )
      .run(`%${FIXTURE_TAG}%`);
    console.log(`[fixture] reverted ${r.changes} row(s)`);
  } else {
    const target = db
      .prepare(
        `SELECT id, name FROM assets
         WHERE thumbnail_path IS NOT NULL
           AND content_format IS NULL
           AND scan_location_id > 0
         ORDER BY id LIMIT 1`,
      )
      .get() as { id: number; name: string } | undefined;
    if (!target) {
      console.error('[fixture] no asset has a local thumbnail — cannot inject');
      app.exit(1);
      return;
    }
    const TEST_GALLERY = JSON.stringify(
      [1, 2, 3, 4, 5].map((i) => ({
        url: `https://omnidex.test/${FIXTURE_TAG}/img${i}.png`,
      })),
    );
    const r = db
      .prepare('UPDATE assets SET orbital_gallery_images = ? WHERE id = ?')
      .run(TEST_GALLERY, target.id);
    console.log(
      `[fixture] injected gallery into id=${target.id} name="${target.name}" (${r.changes} updated)`,
    );
  }
  app.exit(0);
}

// Map each action to its legacy console tag so the CLI output of
// `pnpm refresh-scans` / `enrich-orbital` / `enrich-fab` stays recognizable
// now that the orchestration emits structured `ActionProgress` events instead
// of logging inline.
const ACTION_TAG: Record<ActionProgress['action'], string> = {
  'refresh-scans': 'refresh',
  'enrich-orbital': 'enrich',
  'enrich-fab': 'fab',
};

/** Reproduce the old `[refresh]`/`[enrich]`/`[fab]` console lines from events. */
function logProgressLine(p: ActionProgress): void {
  const tag = `[${ACTION_TAG[p.action]}]`;
  const line = p.message ?? '';
  if (p.phase === 'error') {
    console.error(`${tag} ${line}`);
  } else {
    console.log(`${tag} ${line}`);
  }
}

async function runRefreshAndQuit(): Promise<void> {
  progressBus.on('progress', logProgressLine);
  try {
    await refreshAllScans();
  } finally {
    progressBus.off('progress', logProgressLine);
  }
  app.exit(0);
}

async function runExtractMissingThumbsAndQuit(): Promise<void> {
  const db = openDatabase();
  const root = thumbnailsDir();

  // Repair pass: rewrite legacy `\Roaming\Electron\thumbnails\` paths to the
  // current `\Roaming\Omnidex\thumbnails\` location (the productName change
  // moved userData but the OLD DB still references the old dir). Then for
  // every row claiming a local thumbnail, verify the file is actually on
  // disk; clear the flag for any that aren't so the extractor below picks
  // them up.
  const fsMod = await import('node:fs');
  const repaired = db
    .prepare(
      "UPDATE assets SET thumbnail_path = REPLACE(thumbnail_path, '\\Roaming\\Electron\\thumbnails\\', '\\Roaming\\Omnidex\\thumbnails\\') WHERE thumbnail_path LIKE '%\\Roaming\\Electron\\thumbnails\\%'",
    )
    .run();
  console.log(`[thumbs] repaired ${repaired.changes} legacy path(s)`);

  const claimed = db
    .prepare(
      'SELECT id, thumbnail_path FROM assets WHERE has_local_thumbnail = 1 AND thumbnail_path IS NOT NULL',
    )
    .all() as { id: number; thumbnail_path: string }[];
  const clearStmt = db.prepare(
    'UPDATE assets SET has_local_thumbnail = 0, thumbnail_path = NULL WHERE id = ?',
  );
  let cleared = 0;
  for (const c of claimed) {
    if (!fsMod.existsSync(c.thumbnail_path)) {
      clearStmt.run(c.id);
      cleared += 1;
    }
  }
  console.log(`[thumbs] cleared ${cleared} stale flag(s) (file missing on disk)`);

  const rows = db
    .prepare(
      `SELECT id, file_path FROM assets
       WHERE (has_local_thumbnail IS NULL OR has_local_thumbnail = 0)
         AND content_format IS NULL
         AND scan_location_id > 0
         AND asset_type IN ('unreal_pack', 'folder')
       ORDER BY id`,
    )
    .all() as { id: number; file_path: string }[];

  const thumbStmt = db.prepare(
    'UPDATE assets SET thumbnail_path = ?, has_local_thumbnail = 1 WHERE file_path = ?',
  );

  console.log(`[thumbs] ${rows.length} asset(s) missing thumbnails; root=${root}`);

  const CONCURRENCY = 4;
  const PER_PACK_TIMEOUT_MS = 10_000;
  let extracted = 0;
  let skipped = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const slice = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (row) => {
        try {
          const source = await findThumbnailSource(row.file_path);
          if (!source) {
            skipped += 1;
            return;
          }
          // Plain preview images are usable as-is; only .uasset needs the
          // native extractor.
          const fromSource =
            source.kind === 'image'
              ? source.path
              : await Promise.race([
                  extractThumbnail(source.path, root, 256).catch(() => null),
                  new Promise<null>((resolve) =>
                    setTimeout(() => resolve(null), PER_PACK_TIMEOUT_MS),
                  ),
                ]);
          const pngPath = fromSource ?? (source.kind === 'uasset' ? source.fallback : null);
          if (pngPath) {
            thumbStmt.run(pngPath, row.file_path);
            extracted += 1;
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }),
    );
    if ((i + CONCURRENCY) % 80 === 0 || i + CONCURRENCY >= rows.length) {
      const dt = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(
        `[thumbs] progress ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} extracted=${extracted} skipped=${skipped} elapsed=${dt}s`,
      );
    }
  }

  console.log(
    `[thumbs] complete in ${((Date.now() - t0) / 1000).toFixed(1)}s — extracted=${extracted} skipped=${skipped}`,
  );
  app.exit(0);
}

async function runEnrichOrbitalAndQuit(): Promise<void> {
  progressBus.on('progress', logProgressLine);
  try {
    await enrichOrbital();
  } finally {
    progressBus.off('progress', logProgressLine);
  }
  app.exit(0);
}

/** Read a single line (the Epic `authorizationCode`) from stdin. CLI-only. */
function readAuthCodeFromStdin(redirectUrl: string): Promise<string> {
  console.log('');
  console.log('================================================================');
  console.log('  ACTION REQUIRED — Re-authorize Omnidex against your Epic account');
  console.log('================================================================');
  console.log('');
  console.log('  1. Make sure you are signed into Epic Games in your browser');
  console.log(`  2. Open: ${redirectUrl}`);
  console.log('  3. Copy the value of "authorizationCode" from the JSON page');
  console.log('  4. Paste it below and press Enter:');
  console.log('');
  process.stdout.write('  authorizationCode> ');

  return new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve(line);
      }
    };
    process.stdin.on('data', onData);
  });
}

/** Parse a `--flag <value>` pair out of argv, or undefined if absent. */
function flagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

async function runEnrichFabAndQuit(): Promise<void> {
  const argv = process.argv;
  const fabToken = flagValue(argv, '--fab-token');
  const fabAccount = flagValue(argv, '--fab-account');
  progressBus.on('progress', logProgressLine);
  try {
    await enrichFab({
      fabToken,
      fabAccount,
      // Preserve today's CLI behavior: interactive stdin re-auth on stale creds.
      promptAuthCode: readAuthCodeFromStdin,
    });
  } catch (e) {
    progressBus.off('progress', logProgressLine);
    if (e instanceof FabAuthRequiredError) {
      console.error(`[fab] ${e.message}`);
      console.error(`[fab] Re-authorize at: ${e.redirectUrl}`);
      app.exit(1);
      return;
    }
    console.error('[fab]', (e as Error).message);
    app.exit(1);
    return;
  }
  progressBus.off('progress', logProgressLine);
  app.exit(0);
}

/**
 * Attribute already-indexed courses to their vendor.
 *
 * The manifest pass does this for new scans. This exists so a library that was
 * indexed before attribution landed does not need re-walking — the signal is
 * the course name and the paths beneath it, both already in the DB, and
 * re-reading an MP4 header per video to learn nothing new would be absurd.
 */
async function runBackfillCourseSourcesAndQuit(): Promise<void> {
  try {
    const { openDatabase } = await import('./db');
    const { coursesRepo } = await import('./db/repos');
    const { detectTutorialSource, deriveCourseTitle } = await import('./scanner/course-manifest');
    const result = coursesRepo.backfillTutorialSources(
      openDatabase(),
      detectTutorialSource,
      deriveCourseTitle,
    );
    console.log(
      `[backfill] courses: ${result.updated} attributed, ${result.titled} retitled, of ${result.examined}`,
    );
    app.exit(0);
  } catch (err) {
    console.error('[backfill] failed:', err);
    app.exit(1);
  }
}
