#!/usr/bin/env node
// Self-contained Windows packaging pipeline. Run on Windows 11 (x64):
//
//   node scripts/package-win.mjs            # unsigned local NSIS .exe installer
//   node scripts/package-win.mjs --publish  # signed + uploaded (needs certs)
//
// MUST RUN ON WINDOWS. Native modules (the napi `@omnidex/uasset` addon,
// better-sqlite3, keytar) cannot be cross-compiled from macOS/Linux — they need
// the MSVC toolchain and a Windows host. This is the Windows twin of
// scripts/package-mac.mjs; the platform guard below errors out clearly if it is
// invoked anywhere but win32, exactly like package-mac.mjs's darwin guard.
//
// Why an orchestrator instead of a one-line npm script (same reasons as mac):
//   1. The napi `@omnidex/uasset` addon is NOT built by `pnpm install` (the
//      postinstall only electron-rebuilds better-sqlite3 + keytar). Its `.node`
//      must be compiled for x86_64-pc-windows-msvc, then synced into the
//      resolved `node_modules/@omnidex/uasset` so electron-builder's asarUnpack
//      picks it up. (On this repo that resolved dir is a pnpm symlink straight
//      back to native/uasset, so napi already writes into the resolved location
//      and the sync is a safety net / no-op — see package-mac.mjs notes.)
//   2. better-sqlite3 + keytar must be at Electron's ABI, not Node's. The root
//      postinstall electron-rebuilds them, but we redo it here explicitly so a
//      packaging run is correct even if the tree was touched by a plain
//      `node`-ABI install in between.
//
// The installer target is NSIS / x64 / Windows 11 (see build.win in
// package.json). A separate arch build would be required for arm64 Windows;
// that is intentionally deferred (no CI, per project constraints).

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, opts = {}) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
};

// --- Platform guard ----------------------------------------------------------
// Native modules cannot be cross-built from macOS/Linux. Fail fast, loudly.
if (process.platform !== 'win32') {
  console.error(
    `\n[package-win] This builds a Windows NSIS installer and must run on Windows.\n` +
      `  Current platform: ${process.platform} (${process.arch}).\n` +
      `  The @omnidex/uasset napi addon, better-sqlite3 and keytar are native and\n` +
      `  CANNOT be cross-compiled from macOS/Linux — they need the MSVC toolchain\n` +
      `  on a Windows host. All Windows code + config is in place; run this script\n` +
      `  on a Windows 11 x64 machine to produce the installer.\n`,
  );
  process.exit(1);
}

const publish = process.argv.includes('--publish');

// Windows installer is x64 only (Windows 11 target). arm64 Windows is deferred.
const RUST_TARGET = 'x86_64-pc-windows-msvc';
// NAPI-RS names the artifact by platform-arch-abi. For x86_64-pc-windows-msvc
// that is exactly this file; the @omnidex/uasset loader (native/uasset/index.js)
// requires './omnidex-uasset.win32-x64-msvc.node'. Keep these in lockstep.
const EXPECTED_NODE = 'omnidex-uasset.win32-x64-msvc.node';

// 0. Third-party license notices. Regenerated on every packaging run so the
//    shipped THIRD-PARTY-NOTICES.md never drifts from the dependency tree.
//    electron-builder copies it into the app via `build.extraResources`.
run('node scripts/gen-third-party-notices.mjs');

// 1. App icon (renders build/icon.ico among others).
run('node scripts/build-icon.mjs');

// 2. Native uasset addon — build for x64 MSVC, then sync artifacts into the
//    resolved dependency dir.
console.log('\n[package-win] building @omnidex/uasset addon…');
run('pnpm install', { cwd: join(ROOT, 'native/uasset') });
run(`pnpm exec napi build --platform --release --target ${RUST_TARGET}`, {
  cwd: join(ROOT, 'native/uasset'),
});

const src = join(ROOT, 'native/uasset');
const dest = join(ROOT, 'node_modules/@omnidex/uasset');
if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
// dest is normally a pnpm symlink back to src (same realpath); skip the copy in
// that case so we never copy files onto themselves. Still does real work if a
// future install layout makes dest a separate directory.
const destIsSrc = existsSync(dest) && realpathSync(dest) === realpathSync(src);
if (destIsSrc) {
  console.log(
    '  node_modules/@omnidex/uasset is a symlink to native/uasset — addon already in place, sync skipped.',
  );
} else {
  for (const f of readdirSync(src)) {
    if (f === 'index.js' || f === 'index.d.ts' || f.endsWith('.node')) {
      copyFileSync(join(src, f), join(dest, f));
      console.log(`  synced ${f}`);
    }
  }
}

// 2b. GUARD — fail the build if the expected-arch .node is absent. Without this,
//     electron-builder would happily package an installer with no native addon
//     (or a stale wrong-arch one) and the app would crash at runtime.
const builtNode = join(src, EXPECTED_NODE);
const syncedNode = join(dest, EXPECTED_NODE);
if (!existsSync(builtNode)) {
  console.error(
    `\n[package-win] FATAL: expected native addon not produced by napi build.\n` +
      `  Looked for: ${builtNode}\n` +
      `  napi build --target ${RUST_TARGET} should emit ${EXPECTED_NODE}.\n` +
      `  Check that the MSVC toolchain and the Rust target are installed:\n` +
      `    rustup target add ${RUST_TARGET}\n`,
  );
  process.exit(1);
}
if (!existsSync(syncedNode)) {
  console.error(
    `\n[package-win] FATAL: native addon was built but not present in the resolved\n` +
      `  dependency dir after sync.\n` +
      `  Expected: ${syncedNode}\n`,
  );
  process.exit(1);
}
console.log(`[package-win] native addon present: ${EXPECTED_NODE}`);

// 3. better-sqlite3 + keytar at Electron's ABI (re-run explicitly; see header).
run('node scripts/run-electron.mjs electron-rebuild -f -w better-sqlite3,keytar');

// 4. Renderer + main bundle.
run('pnpm run build');

// 5. electron-builder — NSIS, x64, Windows 11. Skip code signing for
//    local/unsigned builds so the installer always produces; `--publish` enables
//    the signed/upload path (reads CSC_LINK / CSC_KEY_PASSWORD from the env).
const publishFlag = publish ? '--publish always' : '--publish never';
run(`electron-builder --win --x64 ${publishFlag}`);

console.log(
  `\n[package-win] done — see dist-installer/ for Omnidex-Setup-*.exe (x64).`,
);
