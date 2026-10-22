#!/usr/bin/env node
// Guarantee the Electron binary is unpacked at node_modules/electron/dist.
//
// WHY: Homebrew pnpm 11.1.3 frequently ignores `onlyBuiltDependencies` (declared
// in pnpm-workspace.yaml) and SKIPS electron's own postinstall (`install.js`),
// which is what downloads + unzips the Electron binary into
// node_modules/electron/dist. Without dist/, electron-rebuild cannot detect the
// target ABI and packaging fails. We removed the `dangerouslyAllowAllBuilds: true`
// stopgap, so this script explicitly drives electron's install when its build
// script was skipped.
//
// IDEMPOTENT: electron's install.js self-guards via isInstalled() (checks
// dist/version + path.txt), so re-running is a cheap no-op once the binary is
// present. We additionally short-circuit here to avoid spawning at all.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const electronDir = join(repoRoot, 'node_modules', 'electron');

function log(msg) {
  console.log(`[ensure-electron] ${msg}`);
}

if (!existsSync(electronDir)) {
  log('node_modules/electron not present — skipping (electron not a dependency?).');
  process.exit(0);
}

const installScript = join(electronDir, 'install.js');
if (!existsSync(installScript)) {
  log('electron/install.js missing — cannot ensure binary; leaving as-is.');
  process.exit(0);
}

// Cheap pre-check mirroring install.js isInstalled(): if dist/version matches the
// package version and the platform path exists, we are done.
function distVersion() {
  try {
    return readFileSync(join(electronDir, 'dist', 'version'), 'utf8')
      .replace(/^v/, '')
      .trim();
  } catch {
    return null;
  }
}
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

if (distVersion() && distVersion() === pkgVersion()) {
  log(`electron ${pkgVersion()} already installed (dist/ present) — no-op.`);
  process.exit(0);
}

log('electron binary missing — running electron/install.js to download + unpack…');
try {
  execFileSync(process.execPath, [installScript], {
    cwd: electronDir,
    stdio: 'inherit',
  });
} catch (err) {
  console.error(`[ensure-electron] ERROR: electron install.js failed: ${err.message}`);
  process.exit(1);
}

if (!existsSync(join(electronDir, 'dist', 'version'))) {
  console.error('[ensure-electron] ERROR: dist/ still missing after install.js. Aborting.');
  process.exit(1);
}
log('electron binary installed.');
