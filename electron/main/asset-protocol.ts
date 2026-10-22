import { sep } from 'node:path';

/**
 * Pure encode/decode logic for the custom `omnidex-asset://` scheme, factored
 * out of `index.ts` so it's unit-testable without booting Electron.
 *
 * The renderer (electron/preload/index.ts `fileUrl`) encodes an absolute path
 * by replacing backslashes with forward slashes and prefixing
 * `omnidex-asset:///` + `encodeURI(...)`. Because the scheme is registered as
 * `standard: true`, the URL parser treats it as having an authority: the bytes
 * after `://` up to the next `/` are the hostname. A macOS path like
 * `/Users/brandon/...` therefore encodes to FOUR slashes
 * (`omnidex-asset:////Users/...`) and parses to an empty hostname plus a
 * pathname that STILL carries a leading `/` (so `raw` begins `//Users/...`).
 * A Windows path `C:\...` encodes to THREE slashes (`omnidex-asset:///C:/...`)
 * and `raw` begins `/C:/...`.
 *
 * The original decoder did `raw.replace(/^\/+/, '')`, stripping EVERY leading
 * slash. On Windows that correctly removed the single `/` before the `/C:`
 * drive letter, but on macOS it ate the absolute-path root too, turning
 * `/Users/brandon/...` into the relative `Users/brandon/...` — resolved against
 * the process cwd, so every local thumbnail/audio/doc preview 404'd. Only
 * remote Orbital CDN images (which take the `http` short-circuit in `fileUrl`)
 * rendered.
 *
 * `decodeAssetPath` is the exact inverse of the preload encode: on win32 it
 * strips only the single leading slash sitting in front of a `/X:` drive
 * letter; on every other platform it preserves the leading `/` so the absolute
 * root survives.
 */

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
  return `omnidex-asset:///${encodeURI(normalized)}`;
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

  if (platform === 'win32') {
    // Chromium canonicalizes the registered standard scheme BEFORE the protocol
    // handler sees `request.url`, collapsing `omnidex-asset:///C:/Users/x` down
    // to a two-slash form whose authority is the drive letter. So the real
    // request arrives as hostname `c` (hosts are case-folded, and the `:` is
    // consumed as an empty port and dropped), pathname `/Users/x`.
    //
    // Concatenating hostname + pathname then yielded `c/Users/x` — no colon, no
    // leading slash — so the drive-letter strip below never matched, the path
    // stayed relative, and realpath/allowlist rejected every thumbnail with
    // "outside allowlist: c\Users\...".
    //
    // This survived the unit tests because `omnidex-asset` is NOT a special
    // scheme to Node's WHATWG parser: `new URL` leaves the triple slash alone
    // and reports an empty hostname, so an encode→decode round-trip through
    // `new URL` can never reproduce what Chromium actually delivers. Hence the
    // hand-written two-slash cases in the tests.
    //
    // A single-letter authority is only ever a drive letter on win32, so
    // restore its colon. Uppercased for a canonical result; NTFS does not care.
    if (/^[A-Za-z]$/.test(url.hostname)) {
      const rest = decodeURIComponent(url.pathname);
      return `${url.hostname.toUpperCase()}:${rest}`.replace(/\//g, '\\');
    }
    // Empty-authority form (what Node's parser produces, and any caller that
    // hands us a URL directly): `/C:/Users/...` -> `C:/Users/...`, then
    // forward- to back-slashes for a native Windows path.
    const raw = decodeURIComponent(url.hostname + url.pathname);
    return raw.replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/\//g, '\\');
  }

  // The standard-scheme parser puts the first path segment in `hostname` only
  // when there's a single `//`; with our triple/quadruple slash the hostname is
  // empty and the full path lands in `pathname` (still leading-slash-prefixed).
  // Concatenate to be robust either way.
  const raw = decodeURIComponent(url.hostname + url.pathname);
  // POSIX: collapse the doubled leading slash from the empty-authority parse
  // back to a single one, preserving the absolute root. `//Users/...` ->
  // `/Users/...`; a lone `/Users/...` is left untouched.
  return raw.replace(/^\/{2,}/, '/');
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
