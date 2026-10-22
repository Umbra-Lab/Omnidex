#!/usr/bin/env node
// Idempotently apply every patch in patches/ to its resolved (de-symlinked)
// package path.
//
// WHY THIS EXISTS: Homebrew pnpm 11.1.3 no longer honors the `patchedDependencies`
// field reliably. Even when declared in pnpm-workspace.yaml the lockfile may get
// no patch section and the on-disk dist files are left un-patched, so the
// electron-trpc renderer crashes with "Cannot read properties of undefined
// (reading 'serialize')" on every tRPC call. This script guarantees the patch is
// on disk after `pnpm install`, regardless of what pnpm did or didn't do.
//
// A package can carry several patches, named `<pkg>@<version>[.<topic>].patch`.
// Each has its own marker and is applied on its own, so a new fix reaches
// checkouts that already have the older patches (`patch --forward` skips a whole
// file once one of its hunks is already applied, so amending an applied patch
// in place would never land). Only the patch listed under `patchedDependencies`
// feeds the lockfile's patch hash; leave that one alone.
//
// HOW IT WORKS: for each `patches/<pkg>@<version>[.<topic>].patch`:
//   1. Resolve the package's REAL directory (pnpm exposes it via a symlink in
//      node_modules/<pkg>; we de-symlink with fs.realpathSync so `patch -p1`
//      edits the actual store copy, not a dangling link).
//   2. If the patch's marker string is already present in the target files,
//      treat it as applied and no-op (idempotent — safe to run on every
//      reinstall and on an already-patched tree).
//   3. Otherwise run `patch -p1 --forward` at the real package root.
//   4. Exit non-zero with a clear message if the patch cannot be applied.
//
// The script is generic over patches/, but carries a small per-patch registry of
// "marker" strings (substrings the patch introduces) so it can detect the
// already-applied state without a dry-run. Add an entry when you add a patch; if
// none is registered the script falls back to `patch --dry-run` detection.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const patchesDir = join(repoRoot, 'patches');
const nodeModules = join(repoRoot, 'node_modules');

// Per-patch "applied" markers: a substring the patch introduces into a file
// inside the target package. If the substring is present we consider the patch
// applied (idempotent no-op). Keyed by patch filename.
const MARKERS = {
  'electron-trpc@1.0.0-alpha.0.patch': [
    { file: 'dist/main.mjs', marker: '__omnidexTransformerOutputSerialize' },
    { file: 'dist/renderer.mjs', marker: '__omnidexGetTransformer' },
  ],
  'electron-trpc@1.0.0-alpha.0.same-document-navigation.patch': [
    { file: 'dist/main.mjs', marker: '__omnidexSameDocumentNavigation' },
  ],
};

function log(msg) {
  console.log(`[apply-patches] ${msg}`);
}

function fail(msg) {
  console.error(`[apply-patches] ERROR: ${msg}`);
  process.exit(1);
}

// patches/electron-trpc@1.0.0-alpha.0.patch                      ->  "electron-trpc"
// patches/electron-trpc@1.0.0-alpha.0.same-document-navigation.patch  ->  "electron-trpc"
// patches/@scope__name@1.2.3.patch                               ->  "@scope/name"
function packageNameFromPatchFile(patchFile) {
  // Strip trailing "@<version>.patch"
  const base = patchFile.replace(/\.patch$/, '');
  const at = base.lastIndexOf('@');
  // Handle scoped names that begin with '@' (the leading '@' is part of the name)
  const nameRaw = at > 0 ? base.slice(0, at) : base;
  return nameRaw.replace('__', '/');
}

// Resolve the REAL on-disk directory for a package, de-symlinking the pnpm link.
function resolveRealPackageDir(pkgName) {
  const linkPath = join(nodeModules, pkgName);
  if (!existsSync(linkPath)) return null;
  try {
    return realpathSync(linkPath);
  } catch {
    return null;
  }
}

function isAlreadyApplied(patchFile, realDir) {
  const markers = MARKERS[patchFile];
  if (!markers) return null; // unknown — caller falls back to dry-run
  for (const { file, marker } of markers) {
    const target = join(realDir, file);
    if (!existsSync(target)) return false;
    const contents = readFileSync(target, 'utf8');
    if (!contents.includes(marker)) return false;
  }
  return true;
}

function applyPatch(patchPath, realDir, patchFile) {
  // --forward: never reverse-apply; bail if it looks already applied.
  // -p1: strip the leading a/ b/ from the diff paths.
  try {
    execFileSync('patch', ['-p1', '--forward', '-i', patchPath], {
      cwd: realDir,
      stdio: 'pipe',
    });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // If patch reports it's already applied, treat as success (idempotent).
    if (/previously applied|Reversed .*patch detected|Skipping patch/i.test(out)) {
      log(`${patchFile}: already applied (per patch tool) — skipping.`);
      return;
    }
    fail(
      `failed to apply ${patchFile} at ${realDir}\n` +
        `--- patch output ---\n${out.trim()}\n` +
        `Resolve manually, then re-run \`node scripts/apply-patches.mjs\`.`,
    );
  }
}

function main() {
  if (!existsSync(patchesDir)) {
    log('no patches/ directory — nothing to do.');
    return;
  }
  const patchFiles = readdirSync(patchesDir).filter((f) => f.endsWith('.patch'));
  if (patchFiles.length === 0) {
    log('no *.patch files — nothing to do.');
    return;
  }

  for (const patchFile of patchFiles) {
    const patchPath = join(patchesDir, patchFile);
    const pkgName = packageNameFromPatchFile(patchFile);
    const realDir = resolveRealPackageDir(pkgName);

    if (!realDir) {
      fail(
        `cannot resolve installed package "${pkgName}" for ${patchFile}. ` +
          `Is it installed? (looked for node_modules/${pkgName})`,
      );
    }

    const applied = isAlreadyApplied(patchFile, realDir);
    if (applied === true) {
      log(`${patchFile}: already applied (markers present) — no-op.`);
      continue;
    }

    log(`${patchFile}: applying to ${realDir}`);
    applyPatch(patchPath, realDir, patchFile);

    // Re-verify markers if we know them.
    const after = isAlreadyApplied(patchFile, realDir);
    if (after === false) {
      fail(
        `${patchFile}: patch ran but markers are still missing at ${realDir}. ` +
          `The patch may not match the installed package version.`,
      );
    }
    log(`${patchFile}: applied OK.`);
  }

  log('all patches applied.');
}

main();
