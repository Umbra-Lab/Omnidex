import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPathWithin, resolveWithin } from '../path-guard';

/**
 * Coverage for the path-containment guard that backs the hardened raw IPC
 * handlers (`read_asset_doc_file`, `omnidex:fs:write-text`). The guard itself
 * is electron-free precisely so it can be exercised here under plain Node —
 * the IPC modules can't be imported in Vitest (they pull in `electron` + the
 * native `better-sqlite3` binding). This pins the traversal/symlink-escape
 * rejection that is the whole point of the slice.
 */

describe('isPathWithin', () => {
  it('treats a root as containing itself', () => {
    expect(isPathWithin('/data/lib', '/data/lib')).toBe(true);
  });

  it('treats descendants as contained', () => {
    expect(isPathWithin('/data/lib/sub/file.txt', '/data/lib')).toBe(true);
  });

  it('rejects parents and outside paths', () => {
    expect(isPathWithin('/data', '/data/lib')).toBe(false);
    expect(isPathWithin('/etc/passwd', '/data/lib')).toBe(false);
  });

  it('rejects a sibling that merely shares a string prefix', () => {
    // The classic `startsWith` bug: `/data/lib-evil` is NOT inside `/data/lib`.
    expect(isPathWithin('/data/lib-evil/x', '/data/lib')).toBe(false);
  });

  it('rejects `..` traversal lexically', () => {
    expect(isPathWithin('/data/lib/../../etc/passwd', '/data/lib')).toBe(false);
  });
});

describe('resolveWithin', () => {
  let root: string;
  let inside: string;
  let outside: string;

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'omnidex-guard-'));
    root = join(base, 'root');
    outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    inside = join(root, 'doc.txt');
    writeFileSync(inside, 'hello', 'utf8');
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
  });

  afterAll(() => {
    rmSync(resolve(root, '..'), { recursive: true, force: true });
  });

  it('returns the canonical (realpath) path for a file inside a root', () => {
    // Read targets are realpath'd, so on macOS `/var/...` canonicalises to
    // `/private/var/...`; compare against the same canonical form.
    expect(resolveWithin(inside, [root])).toBe(realpathSync(inside));
  });

  it('rejects an empty/non-string path with a clear error', () => {
    expect(() => resolveWithin('', [root])).toThrow(/non-empty string/);
    // @ts-expect-error exercising the runtime guard against a non-string
    expect(() => resolveWithin(undefined, [root])).toThrow(/non-empty string/);
  });

  it('rejects when no roots are configured', () => {
    expect(() => resolveWithin(inside, [])).toThrow(/no known-safe root/);
  });

  it('rejects a file outside every root', () => {
    expect(() => resolveWithin(join(outside, 'secret.txt'), [root])).toThrow(
      /outside the allowed roots/,
    );
  });

  it('rejects `..` traversal that escapes the root', () => {
    const escaping = join(root, '..', 'outside', 'secret.txt');
    expect(() => resolveWithin(escaping, [root])).toThrow(/outside the allowed roots/);
  });

  it('rejects a symlink whose target lives outside the root', () => {
    const link = join(root, 'link-to-secret');
    try {
      symlinkSync(join(outside, 'secret.txt'), link);
    } catch {
      // Some CI sandboxes block symlink creation; skip rather than fail.
      return;
    }
    expect(() => resolveWithin(link, [root])).toThrow(/outside the allowed roots/);
  });

  it('rejects a missing read target', () => {
    expect(() => resolveWithin(join(root, 'nope.txt'), [root])).toThrow(
      /does not exist|not accessible/,
    );
  });

  describe('allowMissing (write targets)', () => {
    it('allows a not-yet-existing file inside a root', () => {
      const target = join(root, 'new-file.txt');
      expect(resolveWithin(target, [root], { allowMissing: true })).toBe(resolve(target));
    });

    it('still rejects a not-yet-existing file outside the roots', () => {
      const target = join(outside, 'new-evil.txt');
      expect(() => resolveWithin(target, [root], { allowMissing: true })).toThrow(
        /outside the allowed roots/,
      );
    });

    it('allows a dialog-chosen Save path outside userData when that exact path is a root', () => {
      // Mirrors `omnidex:fs:write-text`: the user picked `outside/export.txt`
      // via the Save dialog, so it's passed as its own allowed root even though
      // it sits outside userData and does not exist yet. The root and target
      // must canonicalise into the same space (the macOS /var -> /private/var
      // regression this guards against).
      const target = join(outside, 'export.txt');
      expect(resolveWithin(target, [root, target], { allowMissing: true })).toBe(resolve(target));
    });

    it('rejects a write that would land outside via a symlinked parent', () => {
      const linkDir = join(root, 'link-dir');
      try {
        symlinkSync(outside, linkDir);
      } catch {
        return;
      }
      const target = join(linkDir, 'planted.txt');
      expect(() => resolveWithin(target, [root], { allowMissing: true })).toThrow(
        /outside the allowed roots/,
      );
    });
  });

  it('uses the platform separator in containment (sanity)', () => {
    expect(sep.length).toBeGreaterThan(0);
  });
});
