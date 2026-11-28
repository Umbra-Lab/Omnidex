import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isLaunchableBundle,
  isOpenableFile,
  isPathWithin,
  planOpenLocation,
  planOpenPath,
  resolveWithin,
} from '../path-guard';

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

describe('isOpenableFile — what shell.openPath may hand to a default app', () => {
  it('allows course media and documents, any case', () => {
    for (const p of [
      'C:\\Courses\\01 - Intro.MP4',
      '/c/lesson.mkv',
      '/c/notes.pdf',
      '/c/readme.md',
      '/c/cover.JPG',
      '/c/part.ts',
    ]) {
      expect(isOpenableFile(p), p).toBe(true);
    }
  });

  it('refuses anything that could run, and names with no extension', () => {
    for (const p of [
      'C:\\Packs\\Setup.exe',
      'C:\\Packs\\install.bat',
      'C:\\Packs\\Docs.lnk',
      'C:\\Packs\\site.url',
      'C:\\Packs\\x.scr',
      'C:\\Packs\\run.ps1',
      'C:\\Packs\\macro.doc',
      'C:\\Packs\\macro.docx',
      'C:\\Packs\\ole.rtf',
      '/Users/me/Packs/start.command',
      '/home/me/packs/build.sh',
      '/home/me/packs/video.mp4.exe',
      '/home/me/packs/Makefile',
      '/home/me/packs/.mp4',
      '/home/me/v.1/README',
    ]) {
      expect(isOpenableFile(p), p).toBe(false);
    }
  });
});

describe('isLaunchableBundle — folders openPath would launch', () => {
  it('spots macOS bundles, with or without a trailing slash', () => {
    expect(isLaunchableBundle('/Users/me/Packs/Tool.app')).toBe(true);
    expect(isLaunchableBundle('/Users/me/Packs/Tool.APP/')).toBe(true);
    expect(isLaunchableBundle('/Users/me/Packs/Thing.workflow')).toBe(true);
  });

  it('leaves ordinary pack folders alone', () => {
    expect(isLaunchableBundle('/Users/me/Packs/Medieval Village')).toBe(false);
    expect(isLaunchableBundle('/Users/me/Packs/my.application.pack')).toBe(false);
    expect(isLaunchableBundle('C:\\Packs\\Apps')).toBe(false);
  });
});

describe('shell plans — decided on the real target, opened on the real target', () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'omnidex-shell-')));
    mkdirSync(join(root, 'Pack'));
    mkdirSync(join(root, 'Evil.app'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'lesson.mp4'), '');
    writeFileSync(join(root, 'run.command'), '');
    writeFileSync(join(root, 'Setup.exe'), '');
    symlinkSync(join(root, 'Evil.app'), join(root, 'sub', 'clip'), 'dir');
    symlinkSync(join(root, 'run.command'), join(root, 'sub', 'video.mp4'));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('open-path opens media and folders, and refuses what could run', () => {
    expect(planOpenPath(join(root, 'lesson.mp4'), [root])).toEqual({
      kind: 'open',
      path: join(root, 'lesson.mp4'),
    });
    expect(planOpenPath(join(root, 'Pack'), [root])).toEqual({
      kind: 'open',
      path: join(root, 'Pack'),
    });
    expect(planOpenPath(join(root, 'Setup.exe'), [root])).toMatchObject({ kind: 'refuse' });
    expect(planOpenPath(join(root, 'Evil.app'), [root])).toEqual({
      kind: 'reveal',
      path: join(root, 'Evil.app'),
    });
  });

  it('judges a symlink by its target: a link to a bundle or a script cannot launch it', () => {
    expect(planOpenPath(join(root, 'sub', 'clip'), [root])).toEqual({
      kind: 'reveal',
      path: join(root, 'Evil.app'),
    });
    expect(planOpenPath(join(root, 'sub', 'video.mp4'), [root])).toMatchObject({ kind: 'refuse' });
    expect(planOpenLocation(join(root, 'sub', 'clip'), [root])).toEqual({
      kind: 'reveal',
      path: join(root, 'Evil.app'),
    });
  });

  it('open-file-location reveals files and opens folders', () => {
    expect(planOpenLocation(join(root, 'Setup.exe'), [root])).toEqual({
      kind: 'reveal',
      path: join(root, 'Setup.exe'),
    });
    expect(planOpenLocation(join(root, 'Pack'), [root])).toEqual({
      kind: 'open',
      path: join(root, 'Pack'),
    });
  });

  it('opens the parent of a path that is gone, unless that parent is a bundle', () => {
    expect(planOpenLocation(join(root, 'Pack', 'gone'), [root])).toEqual({
      kind: 'open',
      path: join(root, 'Pack'),
      openedParent: true,
    });
    expect(planOpenLocation(join(root, 'Evil.app', 'nope'), [root])).toEqual({
      kind: 'reveal',
      path: join(root, 'Evil.app'),
    });
    expect(planOpenLocation(join(root, 'no', 'such', 'thing'), [root])).toEqual({
      kind: 'refuse',
      error: 'not found',
    });
  });

  it('refuses anything outside the roots, missing or not', () => {
    expect(planOpenPath(tmpdir(), [root])).toEqual({ kind: 'refuse', error: 'path not allowed' });
    expect(planOpenLocation(join(tmpdir(), 'nope-omnidex'), [root])).toEqual({
      kind: 'refuse',
      error: 'path not allowed',
    });
  });
});
