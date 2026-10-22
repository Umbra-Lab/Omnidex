#!/usr/bin/env node
// Self-contained macOS packaging pipeline. Run on a Mac:
//
//   node scripts/package-mac.mjs            # unsigned local .dmg + .zip
//   node scripts/package-mac.mjs --publish  # signed + uploaded (needs certs)
//
// Why an orchestrator instead of a one-line npm script:
//   1. The napi `@omnidex/uasset` addon is NOT built by `pnpm install` (the
//      postinstall only electron-rebuilds better-sqlite3 + keytar). Its `.node`
//      must be compiled for the host arch so electron-builder's asarUnpack picks
//      it up. NOTE: `@omnidex/uasset` is declared `file:native/uasset`, and pnpm
//      links it as a SYMLINK — `node_modules/@omnidex/uasset` resolves straight
//      back to `native/uasset` (verified: same inode). So `napi build` already
//      writes the .node/index.js/index.d.ts INTO the resolved dependency dir,
//      and the copy loop below is a no-op self-copy on this layout. It is kept
//      only as a cheap safety net for a hypothetical non-symlinked install
//      (e.g. node_modules hoisting changes); copyFileSync is skipped when src
//      and dest are the same realpath so it never copies a file onto itself.
//   2. We package for the HOST arch only (arm64 on Apple Silicon, x64 on Intel)
//      so the single produced .dmg always has a matching native addon. To ship
//      a universal/dual-arch build, add the other rust target
//      (`rustup target add x86_64-apple-darwin`) and pass --universal.

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

if (process.platform !== 'darwin') {
  console.error(
    `\n[package-mac] This builds a macOS .dmg and must run on macOS.\n` +
      `  Current platform: ${process.platform} (${process.arch}).\n` +
      `  All macOS code + config is in place; run this script on a Mac (or a\n` +
      `  macOS CI runner) to produce the installer.\n`,
  );
  process.exit(1);
}

const publish = process.argv.includes('--publish');
const universal = process.argv.includes('--universal');
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';

// 0. Third-party license notices. Regenerated on every packaging run so the
//    shipped THIRD-PARTY-NOTICES.md never drifts from the dependency tree.
//    electron-builder copies it into the app via `build.extraResources`.
run('node scripts/gen-third-party-notices.mjs');

// 1. App icon (renders build/icon.icns among others).
run('node scripts/build-icon.mjs');

// 2. Native uasset addon — build for the host arch (and the sibling arch when
//    --universal), then sync artifacts into the resolved dependency dir.
console.log('\n[package-mac] building @omnidex/uasset addon…');
run('pnpm install', { cwd: join(ROOT, 'native/uasset') });
const napiTargets = universal
  ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  : [process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'];
for (const target of napiTargets) {
  run(`pnpm exec napi build --platform --release --target ${target}`, {
    cwd: join(ROOT, 'native/uasset'),
  });
}

const src = join(ROOT, 'native/uasset');
const dest = join(ROOT, 'node_modules/@omnidex/uasset');
if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
// On this repo dest is a symlink back to src (same realpath), so the copy is a
// no-op; skip it to avoid copying files onto themselves. The loop still does
// real work if a future install layout makes dest a separate directory.
const destIsSrc =
  existsSync(dest) && realpathSync(dest) === realpathSync(src);
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

// 3. Renderer + main bundle.
run('pnpm run build');

// 4. electron-builder. Skip code signing for local/unsigned builds so the dmg
//    always produces; `--publish` enables the signed path (reads CSC_LINK /
//    APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID from the env).
const archFlags = universal ? '--universal' : `--${hostArch}`;
const publishFlag = publish ? '--publish always' : '--publish never';
const signEnv = publish ? '' : 'CSC_IDENTITY_AUTO_DISCOVERY=false ';
run(`${signEnv}electron-builder --mac ${archFlags} ${publishFlag}`);

console.log(
  `\n[package-mac] done — see dist-installer/ for Omnidex-*.dmg (${universal ? 'universal' : hostArch}).`,
);
