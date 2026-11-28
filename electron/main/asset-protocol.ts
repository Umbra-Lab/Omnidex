import { sep, win32 } from 'node:path';

/**
 * Pure encode/decode logic for the custom `omnidex-asset://` scheme, factored
 * out of `index.ts` so it's unit-testable without booting Electron.
 *
 * The scheme is registered as `standard: true`, so Chromium parses everything
 * between `://` and the next `/` as the AUTHORITY (hostname), and it skips any
 * run of slashes after the scheme to find it. Earlier encodings put the path
 * straight after `omnidex-asset:///`, so the first path segment became the
 * hostname once Chromium canonicalized the request:
 *
 *   - Windows `C:\Users\x`      -> host `c`, pathname `/Users/x`
 *   - macOS   `/Users/x`         -> host `users`, pathname `/x`
 *   - Linux   `/home/x`          -> host `home`, pathname `/x`
 *   - UNC     `\\nas\share\x`    -> host `nas`, pathname `/share/x`
 *
 * Hosts are case-folded and IDNA-normalized, and a first segment with a space
 * is not a valid host at all, so that form lost information. Worse, the posix
 * decoder concatenated `host + pathname` into the RELATIVE `home/x`, which
 * failed the allowlist: every local thumbnail and course video 403'd on macOS
 * and Linux. Node's WHATWG parser does NOT treat `omnidex-asset` as special and
 * keeps the empty authority, which is why round-trip tests through `new URL`
 * never saw it.
 *
 * The encoding now names a fixed authority, `omnidex-asset://local/<path>`, so
 * the whole path, with its case, lives in `pathname` under every parser. The
 * decoder still accepts the older host-carrying forms.
 */

/** The fixed authority every encoded URL carries. */
export const ASSET_URL_HOST = 'local';

/**
 * Encode an absolute filesystem path into an `omnidex-asset://` URL. Mirrors
 * the preload `fileUrl` helper exactly so tests can round-trip through the same
 * transform the renderer uses.
 */
export function encodeAssetUrl(absolutePath: string): string {
  if (!absolutePath) return '';
  if (absolutePath.startsWith('omnidex-asset://') || absolutePath.startsWith('http')) {
    return absolutePath;
  }
  const normalized = absolutePath.replace(/\\/g, '/');
  const rooted = normalized.startsWith('/') ? normalized : `/${normalized}`;
  // Keep in sync with the copy in electron/preload/index.ts fileUrl; a source-parity test in asset-protocol.test.ts enforces this.
  // encodeURI leaves # and ? alone; they would start a fragment/query and truncate the path.
  return `omnidex-asset://local${encodeURI(rooted).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/**
 * Decode an `omnidex-asset://` URL back to the absolute filesystem path the
 * preload `fileUrl` encoded, in a platform-correct way.
 *
 * @param assetUrl the full `omnidex-asset://...` request URL
 * @param platform the running platform; defaults to `process.platform` so the
 *   protocol handler stays a one-arg call, while tests can pin `'darwin'` /
 *   `'win32'` deterministically.
 * @returns the decoded native path (forward slashes on posix, backslashes on
 *   win32), ready for `pathToFileURL`.
 */
export function decodeAssetPath(
  assetUrl: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const url = new URL(assetUrl);
  const host = url.hostname;
  const pathname = decodeURIComponent(url.pathname);

  // Current form: fixed authority, the full absolute path in `pathname`.
  // Legacy forms: an empty authority (Node's parser, direct callers) also
  // leaves the full path in `pathname`, possibly with a doubled leading slash.
  // Any other host is a first path segment that Chromium promoted to the
  // authority (see the file comment); put it back in front of the pathname.
  let raw: string;
  if (host === ASSET_URL_HOST) {
    raw = pathname;
  } else if (host === '') {
    raw = pathname.replace(/^\/{2,}(?=[A-Za-z]:\/)/, '/');
  } else if (platform === 'win32' && /^[A-Za-z]$/.test(host)) {
    // `omnidex-asset://c:/Users/x`: the drive letter became the host and its
    // colon was consumed as an empty port. Uppercase for a canonical result.
    raw = `/${host.toUpperCase()}:${pathname}`;
  } else if (platform === 'win32') {
    // A UNC server Chromium promoted to the host: `\\\\nas\\share` was encoded
    // `omnidex-asset:////nas/share` and arrives as host `nas`.
    raw = `//${decodeURIComponent(host)}${pathname}`;
  } else {
    raw = `/${decodeURIComponent(host)}${pathname}`;
  }

  if (platform === 'win32') {
    // `/C:/Users/x` -> `C:\Users\x`. A UNC path keeps its two leading slashes
    // (`//nas/share/x` -> `\\nas\share\x`).
    return raw.replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/\//g, '\\');
  }
  // POSIX: collapse a doubled leading slash (empty-authority legacy form) back
  // to the single absolute root.
  return raw.replace(/^\/{2,}/, '/');
}

/**
 * True for a Windows UNC path (`\\\\server\\share\\...`, or `//server/...`).
 *
 * Touching one at all (realpath, stat, open) makes Windows connect to that
 * server and offer the user's NTLM credentials. The handler must therefore
 * decide whether a UNC path is allowed from its text alone, before any
 * filesystem call; see `isUncPathPermitted`.
 */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p);
}

/**
 * Lexical allowlist check for a UNC path, done before the filesystem is
 * touched. The path is normalized (collapsing `.`/`..`) and must sit under an
 * allowed root that is itself a UNC path, i.e. a scan location on a network
 * share the user added. Case-insensitive, as Windows is. The realpath check
 * still runs afterwards; this only keeps a request for
 * `\\\\attacker.example\\x.png` from ever reaching the network.
 */
export function isUncPathPermitted(candidate: string, allowedRoots: readonly string[]): boolean {
  const normalized = win32.normalize(candidate);
  const uncRoots = allowedRoots.filter(isUncPath).map((r) => win32.normalize(r));
  return isPathAllowed(normalized, uncRoots, '\\', true);
}

/**
 * Append a trailing separator to a directory root so a prefix test can't be
 * fooled by a sibling whose name merely *starts* with an allowed root (e.g.
 * `/data/scans` must NOT permit `/data/scans-secret`). Idempotent.
 */
function withTrailingSep(root: string, platformSep: string = sep): string {
  return root.endsWith(platformSep) ? root : root + platformSep;
}

/**
 * Containment test for the `omnidex-asset://` handler — the security boundary
 * that turns an arbitrary-file-read primitive into a scoped one.
 *
 * `candidate` is the realpath of the requested file (symlinks already
 * resolved by the caller via `fs.realpathSync`). `allowedRoots` are the
 * realpaths of the directories the renderer is permitted to read from
 * (userData, plus each ACTIVE scan_location). A file is allowed iff it is the
 * allowed root itself OR sits underneath one (boundary-checked with a trailing
 * separator so `…/scans` does not authorize `…/scans-evil`).
 *
 * Because the caller passes the *realpath* of the candidate, a symlink that
 * points outside every root resolves to its real target here and is rejected —
 * defeating the "symlink inside an allowed dir → /etc/passwd" escape.
 *
 * Comparison is case-INSENSITIVE on macOS (APFS) and Windows (NTFS): realpath
 * preserves the caller's input casing for components it didn't have to
 * disambiguate, so a legitimately-contained path can differ in case from its
 * root (e.g. a re-added scan location typed `/Users/x/Scans` vs a DB-stored
 * `/users/x/scans/t.png`). Folding both sides keeps the boundary check exact
 * (siblings/escapes still rejected) while no longer 403'ing valid thumbnails.
 *
 * @param platformSep injectable path separator so tests can pin posix/win32.
 * @param caseInsensitive injectable case-fold flag (defaults to the host FS).
 */
export function isPathAllowed(
  candidateRealPath: string,
  allowedRoots: readonly string[],
  platformSep: string = sep,
  caseInsensitive: boolean = process.platform === 'darwin' || process.platform === 'win32',
): boolean {
  if (!candidateRealPath) return false;
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const candidate = fold(candidateRealPath);
  for (const root of allowedRoots) {
    if (!root) continue;
    const folded = fold(root);
    if (candidate === folded) return true;
    if (candidate.startsWith(withTrailingSep(folded, platformSep))) return true;
  }
  return false;
}

/** A resolved byte range, inclusive on both ends as HTTP defines it. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Parse an HTTP `Range` header against a known file size.
 *
 * Returns a resolved range, `'unsatisfiable'` when the header is well-formed
 * but asks for bytes past the end (the caller must answer 416), or `null` when
 * there is nothing to honour — no header, a non-`bytes` unit, a multi-range
 * request, or syntax the spec says to ignore. `null` means "serve the whole
 * file with 200", which is the correct fallback for every one of those cases.
 *
 * Why this exists: `net.fetch` on a `file://` URL already returns the right
 * BYTES for a forwarded `Range`, but answers `200` with no `Content-Range` and
 * no `Accept-Ranges`. Chromium's media stack will not build a seekable range
 * from an unlabelled 200, so `video.seekable` stayed empty and every seek
 * landed at 0 — which silently broke Learn's resume-at-position as well as
 * scrubbing. The bytes were never the problem; the envelope was.
 *
 * Multi-range (`bytes=0-99,200-299`) deliberately returns `null` rather than
 * being half-supported: a correct answer is a `multipart/byteranges` body, no
 * media element asks for one, and serving the first range while claiming to
 * serve both would be a silent correctness bug.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const match = /^bytes=(.*)$/i.exec(header.trim());
  if (!match) return null;
  const spec = match[1].trim();
  if (spec.includes(',')) return null;

  const dash = spec.indexOf('-');
  if (dash === -1) return null;
  const rawStart = spec.slice(0, dash).trim();
  const rawEnd = spec.slice(dash + 1).trim();

  // A zero-length file can satisfy no range at all; `bytes=0-` included.
  if (size <= 0) return 'unsatisfiable';

  // DIGITs only, per the grammar. `Number()` alone is far too generous for a
  // header: it accepts `1e3`, `0x10`, `+5` and `Infinity`, so `bytes=-1e3`
  // would resolve to a perfectly plausible 1000-byte suffix off a string no
  // client is allowed to send.
  const digits = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);

  // Suffix form `bytes=-500` means "the last 500 bytes".
  if (rawStart === '') {
    const suffix = digits(rawEnd);
    if (suffix === null || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = digits(rawStart);
  if (start === null) return null;
  if (start >= size) return 'unsatisfiable';

  // Open form `bytes=1000-` runs to the end. This is the one media elements
  // send first, so it has to resolve rather than fall through to 200.
  if (rawEnd === '') return { start, end: size - 1 };

  const end = digits(rawEnd);
  if (end === null || end < start) return null;
  // An end past EOF is clamped, not rejected — RFC 9110 says to satisfy what
  // exists rather than fail the request.
  return { start, end: Math.min(end, size - 1) };
}
