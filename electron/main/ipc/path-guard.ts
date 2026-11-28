import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Filesystem-path containment guard for the raw `ipcMain.handle` surface.
 *
 * The renderer is untrusted: every path it hands to a read/write IPC handler
 * has to be proven to live under a known-safe root before we touch disk.
 * Without this, a malicious/compromised renderer could supply `/etc/passwd`,
 * `..\\..\\..\\Windows\\...`, or a symlink that dereferences outside the
 * library and have the main process read or overwrite it with full user
 * privileges. This mirrors the containment idea behind the `omnidex-asset://`
 * protocol handler, but as a reusable, electron-free helper so it can be unit
 * tested under plain Node (the IPC modules pull in `electron` + the native
 * `better-sqlite3` binding and can't be imported in Vitest — see
 * `__tests__/path-guard.test.ts`).
 *
 * Roots are passed in by the caller (the active scan-location roots and the
 * Electron userData dir) rather than read here, so this module stays pure.
 */

/**
 * True iff `child` resolves to `root` itself or a descendant of it. Uses
 * `path.relative` rather than a `startsWith` prefix check so sibling
 * directories that merely share a string prefix (e.g. `/data/lib` vs
 * `/data/lib-evil`) are NOT treated as contained.
 *
 * Both inputs are resolved to absolute form first. Callers that care about
 * symlink escapes must realpath the inputs before calling (see
 * `resolveWithin`), since this is a pure lexical check.
 */
export function isPathWithin(child: string, root: string): boolean {
  // macOS (APFS) + Windows (NTFS) are case-insensitive; fold both sides so a
  // case-mismatched-but-contained path is not spuriously rejected. Symmetric,
  // so sibling/escape rejection is unaffected. Case-sensitive on Linux.
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const absChild = fold(resolve(child));
  const absRoot = fold(resolve(root));
  if (absChild === absRoot) return true;
  const rel = relative(absRoot, absChild);
  // `rel` escapes the root when it's empty-after-resolve, starts with `..`, or
  // is itself an absolute path (different drive on win32).
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Canonicalise a root for comparison. If it exists we realpath it whole; if it
 * doesn't yet (e.g. a dialog-chosen Save path whose file hasn't been created)
 * we realpath its nearest existing ancestor and re-append the trailing
 * segments — the SAME canonical space the target is mapped into, so the
 * equality-based containment check doesn't spuriously fail when only one side
 * went through realpath (e.g. macOS `/var` -> `/private/var`).
 */
function realRoot(root: string): string {
  try {
    return realpathSync(resolve(root));
  } catch {
    return realpathExistingAncestor(resolve(root));
  }
}

export interface ContainmentOptions {
  /**
   * When true the target itself need not exist yet (a write target); we
   * realpath its nearest existing ancestor and require THAT to be contained,
   * which still defeats `..`/symlink escapes on every existing path segment.
   * When false (a read target) the target must exist and is realpath'd whole.
   */
  allowMissing?: boolean;
}

/**
 * Resolve `inputPath` and require it to live within at least one of `roots`,
 * defeating both `..` traversal and symlink escapes by comparing realpath'd
 * forms. Returns the canonical absolute path on success; throws a clear,
 * renderer-safe `Error` otherwise.
 */
export function resolveWithin(
  inputPath: string,
  roots: readonly string[],
  options: ContainmentOptions = {},
): string {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const resolvedRoots = roots.map(realRoot).filter((r) => r.length > 0);
  if (resolvedRoots.length === 0) {
    throw new Error('no known-safe root is configured to contain this path');
  }

  const abs = resolve(inputPath);
  let canonical: string;
  if (options.allowMissing) {
    // Realpath the deepest existing ancestor so symlinks anywhere along the
    // existing portion are dereferenced before the containment check, while
    // still allowing the final (not-yet-created) file name to be new.
    canonical = realpathExistingAncestor(abs);
  } else {
    try {
      canonical = realpathSync(abs);
    } catch {
      throw new Error('path does not exist or is not accessible');
    }
  }

  for (const root of resolvedRoots) {
    if (isPathWithin(canonical, root)) return options.allowMissing ? abs : canonical;
  }
  throw new Error('path is outside the allowed roots');
}

/**
 * Realpath the nearest existing ancestor of `abs` and re-join the
 * not-yet-existing trailing segments onto it. This canonicalises every real
 * directory in the chain (so a symlinked parent is resolved) without requiring
 * the leaf to exist.
 */
function realpathExistingAncestor(abs: string): string {
  let current = abs;
  const trailing: string[] = [];
  // Walk up until realpath succeeds or we hit the filesystem root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathSync(current);
      return trailing.length ? resolve(real, ...trailing.reverse()) : real;
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) {
        // Reached the root and nothing resolved — fall back to lexical.
        return abs;
      }
      trailing.push(relative(parent, current));
      current = parent;
    }
  }
}

/**
 * File types `shell.openPath` may hand to the OS default handler: course video,
 * plain documents and images. Everything else is refused.
 *
 * Containment alone is not enough here. Scan roots hold downloaded packs and
 * courses, and opening a file with its default handler RUNS it when it is a
 * program or shortcut (`.exe`, `.bat`, `.lnk`, `.url`, `.scr`, `.command`,
 * `.sh`, ...). Office and RTF files are left out too: they carry macros and
 * OLE exploits, and an extracted download has usually lost the Mark of the
 * Web that keeps macros off. The only caller today is the Learn player's
 * "Open in default player" for a video it cannot decode.
 */
const OPENABLE_EXT = new Set([
  // Video (scanner/course-manifest VIDEO_EXT, plus the transport-stream forms
  // it probes).
  '.mp4',
  '.m4v',
  '.mov',
  '.mkv',
  '.webm',
  '.avi',
  '.wmv',
  '.flv',
  '.ts',
  '.mts',
  '.m2ts',
  // Plain documents.
  '.pdf',
  '.md',
  '.txt',
  // Images.
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
]);

/** True when `path` is a file type that opening with its default app cannot run. */
export function isOpenableFile(path: string): boolean {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (dot <= slash + 1) return false;
  return OPENABLE_EXT.has(path.slice(dot).toLowerCase());
}

/**
 * True for a directory that `shell.openPath` would launch rather than show: a
 * macOS bundle (`Foo.app`, and the other launchable bundle types). Reveal it
 * in its parent instead.
 */
export function isLaunchableBundle(path: string): boolean {
  return /\.(app|prefPane|saver|workflow|action)[\\/]?$/i.test(path);
}

/** What a shell handler should do with a renderer-supplied path. */
export type ShellPlan =
  | { readonly kind: 'open'; readonly path: string; readonly openedParent?: true }
  | { readonly kind: 'reveal'; readonly path: string }
  | { readonly kind: 'refuse'; readonly error: string };

/**
 * Contained, then canonical. Every decision below is made on the realpath and
 * the same path is what gets opened: a symlink named `clip` or `x.mp4` that
 * points at `Evil.app` or `run.command` is judged (and opened) as its target.
 */
function canonicalWithin(
  input: string,
  roots: readonly string[],
): { path: string } | { error: string } {
  try {
    resolveWithin(input, roots, { allowMissing: true });
  } catch {
    return { error: 'path not allowed' };
  }
  try {
    return { path: resolveWithin(input, roots) };
  } catch {
    return { error: 'not found' };
  }
}

/** Folders open in the file manager, bundles are revealed, files must be openable. */
function planExisting(real: string): ShellPlan {
  if (statSync(real).isDirectory()) {
    return isLaunchableBundle(real) ? { kind: 'reveal', path: real } : { kind: 'open', path: real };
  }
  return isOpenableFile(real)
    ? { kind: 'open', path: real }
    : { kind: 'refuse', error: 'file type not allowed' };
}

/** `omnidex:shell:open-path`: open a file or folder with its default app. */
export function planOpenPath(input: string, roots: readonly string[]): ShellPlan {
  const found = canonicalWithin(input, roots);
  if ('error' in found) return { kind: 'refuse', error: found.error };
  return planExisting(found.path);
}

/**
 * `omnidex:shell:open-file-location`: show where something is. A folder opens
 * (a bundle is revealed), a file is revealed in its folder, and a path that is
 * gone opens its parent, flagged so the renderer can say so. The parent goes
 * through the same checks: `<root>/Evil.app/missing` must not launch Evil.app.
 */
export function planOpenLocation(input: string, roots: readonly string[]): ShellPlan {
  const found = canonicalWithin(input, roots);
  if ('error' in found) {
    if (found.error !== 'not found') return { kind: 'refuse', error: found.error };
    const parent = dirname(resolve(input));
    if (!existsSync(parent)) return { kind: 'refuse', error: 'not found' };
    const real = canonicalWithin(parent, roots);
    if ('error' in real) return { kind: 'refuse', error: real.error };
    if (!statSync(real.path).isDirectory()) return { kind: 'refuse', error: 'not found' };
    return isLaunchableBundle(real.path)
      ? { kind: 'reveal', path: real.path }
      : { kind: 'open', path: real.path, openedParent: true };
  }
  if (statSync(found.path).isDirectory()) return planExisting(found.path);
  return { kind: 'reveal', path: found.path };
}
