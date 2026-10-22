#!/usr/bin/env node
// Ensure the @omnidex/uasset napi addon is built for the current platform.
//
// WHY: index.js / index.d.ts are committed (arch-independent NAPI-RS glue), so
// `pnpm check` (tsc type-check) works on a fresh clone with no Rust toolchain.
// But the platform-specific `*.node` binary is gitignored and only produced by
// `napi build`. The main process imports the addon at startup, so launching
// Electron without it raises a blocking "Cannot find native binding" dialog.
//
// Callers:
//   postinstall (`--soft`)  — a missing toolchain or failed build is a loud
//                             warning, never a failed `pnpm install`.
//   run-electron.mjs, tests/global-setup.ts (hard) — exit non-zero so nothing
//                             launches Electron without the binary.
//
// Order: no-op if a binary is present → copy one from another worktree of this
// repo whose addon sources are byte-identical and whose binary is newer than
// them → build with cargo. Set OMNIDEX_UASSET_NO_COPY=1 to skip the copy step.

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const uassetDir = join(repoRoot, 'native', 'uasset');
const soft = process.argv.includes('--soft');

// Everything `napi build` compiles from, plus the committed loader that names
// the binary. A binary built from other bytes than these is not ours.
const SOURCE_FILES = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'index.js'];
const SOURCE_DIRS = ['src'];

function log(msg) {
  console.log(`[ensure-uasset] ${msg}`);
}

function fail(msg) {
  if (soft) {
    const bar = '!'.repeat(78);
    console.warn(`\n${bar}\n[ensure-uasset] WARNING: ${msg}\n`);
    console.warn('  pnpm install continues, but Electron will not start until the addon');
    console.warn('  exists: `pnpm dev`, `pnpm preview` and `pnpm test:electron` stop here.');
    console.warn(`${bar}\n`);
    process.exit(0);
  }
  console.error(`[ensure-uasset] ERROR: ${msg}`);
  process.exit(1);
}

function nodeBinaries(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.node'));
  } catch {
    return [];
  }
}

function sourcePaths(dir) {
  const paths = SOURCE_FILES.map((f) => join(dir, f)).filter((p) => existsSync(p));
  for (const sub of SOURCE_DIRS) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) paths.push(join(entry.parentPath, entry.name));
    }
  }
  return paths.sort();
}

function fingerprint(dir) {
  const hash = createHash('sha256');
  for (const p of sourcePaths(dir)) {
    hash.update(relative(dir, p).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(p));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// A binary older than any source file was built before that file last changed.
// index.js is left out: `napi build` rewrites it just after writing the binary.
function isStale(dir, binaries) {
  const compiled = sourcePaths(dir).filter((p) => relative(dir, p) !== 'index.js');
  const newestSource = Math.max(...compiled.map((p) => statSync(p).mtimeMs));
  const oldestBinary = Math.min(...binaries.map((f) => statSync(join(dir, f)).mtimeMs));
  return oldestBinary < newestSource;
}

function otherWorktrees() {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const self = repoRoot.toLowerCase();
  return out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length).trim()))
    .filter((p) => p.toLowerCase() !== self);
}

function copyFromWorktree() {
  if (process.env.OMNIDEX_UASSET_NO_COPY === '1') return false;
  const want = fingerprint(uassetDir);
  for (const tree of otherWorktrees()) {
    const donorDir = join(tree, 'native', 'uasset');
    const binaries = nodeBinaries(donorDir);
    if (binaries.length === 0) continue;
    try {
      if (isStale(donorDir, binaries) || fingerprint(donorDir) !== want) continue;
      const now = new Date();
      for (const f of binaries) {
        // Windows keeps the donor's mtime on copy, which would read as stale
        // against this checkout's freshly written sources.
        copyFileSync(join(donorDir, f), join(uassetDir, f));
        utimesSync(join(uassetDir, f), now, now);
      }
    } catch {
      continue;
    }
    log(`copied ${binaries.join(', ')} from ${tree} (identical addon sources).`);
    return true;
  }
  return false;
}

function hasCargo() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const present = nodeBinaries(uassetDir);
if (present.length > 0) {
  if (isStale(uassetDir, present)) {
    console.warn(
      `[ensure-uasset] WARNING: ${present.join(', ')} is older than the addon sources in ` +
        'native/uasset and may predate a source change. Rebuild it: pnpm build:uasset',
    );
  } else {
    log('native addon binary already present — no-op.');
  }
  process.exit(0);
}

if (copyFromWorktree()) process.exit(0);

if (!hasCargo()) {
  fail(
    'no `cargo` on PATH and native/uasset/*.node is missing.\n' +
      '  Install Rust (https://rustup.rs), open a new shell, then run: pnpm ensure:uasset',
  );
}

// The napi CLI is called directly, not through `pnpm run build` or `pnpm
// install`: pnpm checks dependencies before `run` and re-runs `pnpm install`
// when the last install is incomplete, which re-enters the postinstall that may
// be running this script. native/uasset is a workspace package, so the root
// install has already linked the CLI. Keep the arguments in step with the
// `build` script in native/uasset/package.json.
const napiCliDir = join(uassetDir, 'node_modules', '@napi-rs', 'cli');
if (!existsSync(napiCliDir)) {
  fail('@napi-rs/cli is not installed in native/uasset. Run `pnpm install` at the repo root.');
}
const napiBin = JSON.parse(readFileSync(join(napiCliDir, 'package.json'), 'utf8')).bin.napi;

log('building native addon (napi build --platform --release)…');
try {
  execFileSync(process.execPath, [join(napiCliDir, napiBin), 'build', '--platform', '--release'], {
    cwd: uassetDir,
    stdio: 'inherit',
  });
} catch (err) {
  fail(`addon build failed: ${err.message}`);
}

if (nodeBinaries(uassetDir).length === 0) {
  fail('build finished but no *.node produced.');
}
log('native addon built.');
