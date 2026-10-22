// @vitest-environment node
//
// Smoke tests for the native uasset napi-rs addon (`@omnidex/uasset`),
// loaded as the real `.node` binary the app ships. These do NOT re-test the
// Rust internals (covered by `cargo test` in native/uasset/src/thumbnail.rs);
// they assert the FFI contract the Electron main process actually depends on:
//
//   - the binding loads and exports `parseUasset` + `extractThumbnail`
//   - `parseUasset` validates the 0x9E2A83C1 magic and returns header metadata
//   - bad magic surfaces as a catchable JS error (not a process abort)
//   - `extractThumbnail` on a non-uasset / missing file REJECTS gracefully
//     rather than panicking — a Rust panic would cross the FFI boundary and
//     take down the whole Electron process, so "rejects, doesn't crash" is the
//     load-bearing property here.
//
// Runs under the `node` environment (above) because a native addon can't be
// loaded into vitest's jsdom worker.
//
// OPT-IN: this suite SKIPS unless OMNIDEX_TEST_UASSET=1, even when the `.node`
// is built. Calling the napi addon inside vitest's worker segfaults the entire
// run (Windows 0xC0000005) — the binary loads but vitest's worker threads don't
// agree with it. Gating on the env flag (not mere `.node` presence) means a dev
// who runs `pnpm build:uasset` for the Electron app / E2E doesn't get
// `pnpm test:run` crashing out from under them. The addon's real coverage is the
// Electron E2E (where it loads + runs fine) plus the Rust `cargo test` suite.
// To run this FFI smoke deliberately:  OMNIDEX_TEST_UASSET=1 pnpm test:run
// CI never sets it (and installs with --ignore-scripts, so the binary is absent
// there anyway).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const addon = await import('@omnidex/uasset').catch(() => null);
const parseUasset = addon?.parseUasset;
const extractThumbnail = addon?.extractThumbnail;
const runAddon = !!addon && process.env.OMNIDEX_TEST_UASSET === '1';
const describeAddon = runAddon ? describe : describe.skip;

// 0x9E2A83C1 little-endian = C1 83 2A 9E. A real .uasset starts with this.
const UASSET_MAGIC_LE = Buffer.from([0xc1, 0x83, 0x2a, 0x9e]);

let dir: string;
let validMagicPath: string;
let badMagicPath: string;
let nonUassetPath: string;
let outDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omnidex-uasset-smoke-'));
  outDir = join(dir, 'thumbnails');

  // Valid magic, then a garbage body. Enough for the magic gate to pass; the
  // body is intentionally not a parseable UE header (that's the dependency's
  // job, not this binding's), so `hasThumbnail` is false.
  validMagicPath = join(dir, 'valid-magic.uasset');
  writeFileSync(validMagicPath, Buffer.concat([UASSET_MAGIC_LE, Buffer.alloc(64, 0xff)]));

  // Wrong magic — must be rejected by the magic check.
  badMagicPath = join(dir, 'bad-magic.uasset');
  writeFileSync(badMagicPath, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x00]));

  // Not a uasset at all.
  nonUassetPath = join(dir, 'notes.txt');
  writeFileSync(nonUassetPath, 'this is plainly not a uasset file');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describeAddon('native uasset addon loads', () => {
  it('exports parseUasset and extractThumbnail as functions', () => {
    expect(typeof parseUasset).toBe('function');
    expect(typeof extractThumbnail).toBe('function');
  });
});

describeAddon('parseUasset header parsing', () => {
  it('accepts a valid 0x9E2A83C1 magic and returns header metadata', () => {
    const header = parseUasset!(validMagicPath);
    expect(header.magic).toBe('0x9E2A83C1');
    // Garbage body → no embedded thumbnail probed, but parsing still succeeds.
    expect(header.hasThumbnail).toBe(false);
    expect(typeof header.packageFileVersion).toBe('number');
  });

  it('rejects a bad magic with a catchable error (no process abort)', () => {
    // A Rust panic here would abort the whole process; instead the magic
    // mismatch must surface as a normal throwable JS Error.
    expect(() => parseUasset!(badMagicPath)).toThrow(/invalid uasset magic/i);
  });

  it('throws (does not crash) on a non-existent path', () => {
    expect(() => parseUasset!(join(dir, 'does-not-exist.uasset'))).toThrow();
  });
});

describeAddon('extractThumbnail graceful handling', () => {
  it('rejects gracefully on a non-uasset file instead of crashing', async () => {
    // The header parse fails inside Rust and is mapped to a JS error; the key
    // property is that the promise REJECTS (catchable) — the process survives.
    await expect(extractThumbnail!(nonUassetPath, outDir, 128)).rejects.toThrow();
  });

  it('rejects gracefully on valid magic + unparseable body', async () => {
    await expect(extractThumbnail!(validMagicPath, outDir, 128)).rejects.toThrow();
  });

  it('rejects gracefully on a missing file', async () => {
    await expect(extractThumbnail!(join(dir, 'nope.uasset'), outDir, 128)).rejects.toThrow();
  });

  it('survives a sequence of bad inputs without aborting the process', async () => {
    // Hammer the FFI boundary with several failing calls in a row. If any one
    // panicked across the boundary, the process (and this test run) would die
    // rather than letting every call reject — reaching this assertion proves
    // the boundary stays intact.
    const attempts = await Promise.allSettled([
      extractThumbnail!(nonUassetPath, outDir, 64),
      extractThumbnail!(badMagicPath, outDir, 64),
      extractThumbnail!(validMagicPath, outDir, 64),
      extractThumbnail!(join(dir, 'ghost.uasset'), outDir, 64),
    ]);
    expect(attempts).toHaveLength(4);
    expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
  });
});
