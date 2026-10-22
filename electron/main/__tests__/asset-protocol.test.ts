import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeAssetPath,
  encodeAssetUrl,
  isPathAllowed,
  parseRangeHeader,
} from '../asset-protocol';

/**
 * Round-trip coverage for the `omnidex-asset://` scheme.
 *
 * Regression: the original decoder stripped EVERY leading slash
 * (`raw.replace(/^\/+/, '')`). On macOS that turned an absolute path like
 * `/Users/brandon/.../thumb.png` into the relative `Users/brandon/.../thumb.png`,
 * which `pathToFileURL` then resolved against the process cwd — so every local
 * thumbnail / audio / doc preview 404'd, and only remote Orbital CDN images
 * (which short-circuit on `http` in the preload) rendered. Windows worked only
 * by accident, because its encoded form is `/C:/...` and stripping the single
 * leading slash leaves the valid `C:/...`.
 *
 * `encodeAssetUrl` here mirrors the preload `fileUrl` helper byte-for-byte, so
 * encode-then-decode must reproduce the EXACT original absolute path on each
 * platform.
 */
describe('omnidex-asset path round-trip', () => {
  it('preserves a macOS absolute path through encode → decode (darwin)', () => {
    const original = '/Users/brandon/Library/Application Support/omnidex/thumbnails/thumb.png';
    const url = encodeAssetUrl(original);
    expect(url.startsWith('omnidex-asset:///')).toBe(true);
    expect(decodeAssetPath(url, 'darwin')).toBe(original);
  });

  it('preserves a Windows absolute path through encode → decode (win32)', () => {
    const original = 'C:\\Users\\brandon\\AppData\\Roaming\\omnidex\\thumbnails\\thumb.png';
    const url = encodeAssetUrl(original);
    expect(decodeAssetPath(url, 'win32')).toBe(original);
  });

  it('keeps the absolute root for a plain posix path (linux)', () => {
    const original = '/home/brandon/.cache/omnidex/preview.mp3';
    expect(decodeAssetPath(encodeAssetUrl(original), 'linux')).toBe(original);
  });

  it('round-trips paths containing spaces and unicode on darwin', () => {
    const original = '/Users/brandon/Assets/Médïa Pack (v2)/thumb 01.png';
    expect(decodeAssetPath(encodeAssetUrl(original), 'darwin')).toBe(original);
  });

  it('round-trips a Windows path with spaces (win32)', () => {
    const original = 'D:\\Game Assets\\Méga Pack (v2)\\thumb 01.png';
    expect(decodeAssetPath(encodeAssetUrl(original), 'win32')).toBe(original);
  });

  it('does NOT mangle a darwin path the old `^/+` strip would have broken', () => {
    // The crux of the bug: an absolute darwin path must NOT become relative.
    const decoded = decodeAssetPath(encodeAssetUrl('/Users/brandon/x.png'), 'darwin');
    expect(decoded.startsWith('/')).toBe(true);
    expect(decoded).toBe('/Users/brandon/x.png');
  });

  it('decodes the empty-authority double-slash form correctly (darwin)', () => {
    // The standard-scheme parser yields `omnidex-asset:////Users/...` for an
    // absolute posix path — two leading slashes survive into the raw path and
    // must collapse to exactly one.
    expect(encodeAssetUrl('/Users/brandon/x.png')).toBe('omnidex-asset:////Users/brandon/x.png');
  });
});

/**
 * The form Chromium ACTUALLY delivers on Windows.
 *
 * These URLs are hand-written rather than produced by `encodeAssetUrl`, because
 * a round-trip through `new URL` cannot reproduce them: `omnidex-asset` is not a
 * special scheme to Node's WHATWG parser, so Node preserves the triple slash and
 * reports an empty hostname. Chromium, which HAS the scheme registered as
 * `standard: true`, canonicalizes it first and hands the protocol handler a
 * two-slash URL whose authority is the drive letter — hostname `c`, the colon
 * consumed as an empty port, pathname `/Users/...`.
 *
 * That mismatch is why the encode→decode tests above stayed green while every
 * one of the user's 330 thumbnails 403'd with
 * `outside allowlist: c\Users\user\AppData\Roaming\Omnidex\thumbnails\...` —
 * the decoder produced a RELATIVE path, so realpath resolved it against the cwd.
 */
describe('omnidex-asset decode — Chromium-canonicalized Windows form', () => {
  it('restores the drive colon when the drive letter became the authority', () => {
    expect(
      decodeAssetPath(
        'omnidex-asset://C:/Users/user/AppData/Roaming/Omnidex/thumbnails/a1b2.png',
        'win32',
      ),
    ).toBe('C:\\Users\\user\\AppData\\Roaming\\Omnidex\\thumbnails\\a1b2.png');
  });

  it('handles the lowercased host Chromium emits', () => {
    // Chromium case-folds hosts, so the drive arrives as `c`, not `C`.
    expect(decodeAssetPath('omnidex-asset://c:/Users/user/x.png', 'win32')).toBe(
      'C:\\Users\\user\\x.png',
    );
  });

  it('returns an ABSOLUTE path, never a cwd-relative one', () => {
    // The actual defect: a relative result is what made realpath resolve against
    // the process cwd and fail containment.
    const decoded = decodeAssetPath('omnidex-asset://d:/Game Assets/thumb.png', 'win32');
    expect(decoded).toMatch(/^[A-Z]:\\/);
    expect(decoded).toBe('D:\\Game Assets\\thumb.png');
  });

  it('percent-decodes spaces and unicode in the Chromium form', () => {
    expect(
      decodeAssetPath('omnidex-asset://e:/M%C3%A9ga%20Pack%20(v2)/thumb%2001.png', 'win32'),
    ).toBe('E:\\Méga Pack (v2)\\thumb 01.png');
  });

  it('still decodes the empty-authority form (Node parser / direct callers)', () => {
    // Both shapes must work: the fix adds a branch, it does not replace one.
    expect(decodeAssetPath('omnidex-asset:///C:/Users/user/x.png', 'win32')).toBe(
      'C:\\Users\\user\\x.png',
    );
  });

  it('does not mistake a real posix path for a drive letter (darwin)', () => {
    // A single-letter FIRST SEGMENT on posix must stay part of the path.
    expect(decodeAssetPath('omnidex-asset:////c/Users/brandon/x.png', 'darwin')).toBe(
      '/c/Users/brandon/x.png',
    );
  });
});

/**
 * Containment for the omnidex-asset:// handler — the security boundary that
 * keeps the renderer from reading arbitrary files (e.g. /etc/passwd, ~/.ssh).
 * `isPathAllowed` is pure (operates on a realpath + a set of allowed realpath
 * roots), so the prefix/boundary logic is tested directly with posix-pinned
 * separators, and the realpath-follows-symlink behaviour is proven end-to-end
 * against a temp dir below.
 */
describe('isPathAllowed — allowlist containment (pure, posix-pinned)', () => {
  const roots = ['/data/userData', '/data/scans/Packs'];

  it('allows a thumbnail under the userData root', () => {
    expect(isPathAllowed('/data/userData/thumbnails/abc.png', roots, '/')).toBe(true);
  });

  it('allows the root directory itself', () => {
    expect(isPathAllowed('/data/userData', roots, '/')).toBe(true);
  });

  it('rejects a `../../../etc/passwd` style path outside every root', () => {
    // After realpath this is what `../../../etc/passwd` collapses to.
    expect(isPathAllowed('/etc/passwd', roots, '/')).toBe(false);
  });

  it('rejects a sibling whose name merely PREFIXES an allowed root', () => {
    // `/data/scans/Packs` must not authorize `/data/scans/Packs-secret`.
    expect(isPathAllowed('/data/scans/Packs-secret/x.png', roots, '/')).toBe(false);
  });

  it('rejects the empty path and empty roots', () => {
    expect(isPathAllowed('', roots, '/')).toBe(false);
    expect(isPathAllowed('/data/userData/x.png', [], '/')).toBe(false);
  });
});

describe('isPathAllowed — symlink escape (real filesystem)', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    // Two sibling temp dirs: `root` is the allowed scan root, `outside` is not.
    // realpath both so macOS's /var -> /private/var symlink doesn't confuse the
    // prefix comparison.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omnidex-allow-')));
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'omnidex-deny-')));
    writeFileSync(join(root, 'thumb.png'), 'png');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    // A symlink that LIVES inside the allowed root but POINTS outside it.
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('allows a real file inside the allowed root (realpath unchanged)', () => {
    const real = realpathSync(join(root, 'thumb.png'));
    expect(isPathAllowed(real, [root])).toBe(true);
  });

  it('rejects a symlink inside the root that points outside it', () => {
    // The handler realpath's BEFORE the allowlist check, so the symlink resolves
    // to its real target in `outside` — which is not under any allowed root.
    const real = realpathSync(join(root, 'escape.txt'));
    expect(real.startsWith(outside)).toBe(true);
    expect(isPathAllowed(real, [root])).toBe(false);
  });
});

describe('parseRangeHeader', () => {
  const SIZE = 1000;

  it('returns null with no header, so the caller serves a whole-file 200', () => {
    expect(parseRangeHeader(null, SIZE)).toBeNull();
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
    expect(parseRangeHeader('', SIZE)).toBeNull();
  });

  it('resolves a closed range inclusively', () => {
    // bytes=0-499 is 500 bytes, not 499 — the off-by-one that corrupts video.
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 });
    expect(parseRangeHeader('bytes=200-299', SIZE)).toEqual({ start: 200, end: 299 });
  });

  it('resolves the open form a media element sends first', () => {
    // `bytes=0-` is the opening request from every <video>; falling through to
    // 200 here is exactly what kept `seekable` empty.
    expect(parseRangeHeader('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('resolves the suffix form as the LAST n bytes', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 });
    // A suffix larger than the file is the whole file, not a negative start.
    expect(parseRangeHeader('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past EOF rather than failing the request', () => {
    expect(parseRangeHeader('bytes=900-99999', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('reports unsatisfiable when the start is at or past EOF', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=5000-6000', SIZE)).toBe('unsatisfiable');
  });

  it('treats an empty file as satisfying nothing', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('ignores multi-range instead of half-honouring it', () => {
    // The correct answer is a multipart/byteranges body. Serving only the first
    // range while labelling it 206 would be silent corruption, so this falls
    // back to a whole-file 200.
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toBeNull();
  });

  it('ignores units it does not implement', () => {
    expect(parseRangeHeader('items=0-99', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes', SIZE)).toBeNull();
  });

  it('ignores malformed and reversed ranges', () => {
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=500-100', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=-', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=-0', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=1.5-2', SIZE)).toBeNull();
    // Number() accepts exponent/hex/sign; the byte-range grammar does not.
    expect(parseRangeHeader('bytes=-1e3', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=0x10-99', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=+5-99', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=1e2-1e3', SIZE)).toBeNull();
  });

  it('accepts the header case-insensitively and tolerates whitespace', () => {
    expect(parseRangeHeader('BYTES=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader('  bytes= 0 - 99 ', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('handles a range covering exactly the last byte', () => {
    expect(parseRangeHeader('bytes=999-999', SIZE)).toEqual({ start: 999, end: 999 });
  });
});
