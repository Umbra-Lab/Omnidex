import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the FAB VaultCache watcher.
 *
 * The headline regression: chokidar v5 removed glob support, so the original
 * `chokidar.watch('**\/*.manifest', { cwd: root, … })` passed the glob to the
 * FS layer as a *literal* directory name. That directory never exists, so the
 * `'add'` handler never fired and FAB new-asset detection was dead on every
 * OS. The integration test below drops a real `.manifest` under a watched
 * root and asserts the handler fires (red against the old glob code, green
 * after the fix that watches the root directly with a `depth` + `ignored`
 * predicate).
 *
 * `electron` is mocked to a controllable `BrowserWindow` so we can observe the
 * `fab-asset-discovered` IPC fan-out without a real renderer.
 */

// A spy window whose webContents.send records every emit. Hoisted so the
// `vi.mock` factory (which is hoisted above imports) can close over it.
const sentEvents = vi.hoisted(() => [] as Array<{ channel: string; payload: unknown }>);

vi.mock('electron', () => {
  const fakeWindow = {
    webContents: {
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload });
      },
    },
  };
  return {
    BrowserWindow: {
      getAllWindows: () => [fakeWindow],
    },
  };
});

import { defaultVaultPath, parseManifest, start, stop } from '../watcher';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'omnidex-fab-watcher-'));
});

afterEach(async () => {
  // Each test owns the singleton watcher; tear it down so the next test starts
  // clean and timers/handles don't leak between cases.
  await stop();
  sentEvents.length = 0;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Poll `predicate` up to `timeoutMs`, resolving as soon as it's true. */
async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('start() — chokidar v5 glob-bug regression', () => {
  it('fires the add handler for a .manifest dropped under the root', async () => {
    const root = mkdtempSync(join(tmp, 'vault-'));
    // Nested, mirroring Epic's `VaultCache/<asset>/...manifest` layout. This
    // also exercises recursion: the old literal-glob code watched a path that
    // never existed, so nothing — top-level or nested — ever fired.
    const dir = join(root, 'MyCoolAsset', 'data');
    mkdirSync(dir, { recursive: true });

    const res = start(root);
    expect(res).toEqual({ watching: root });

    // Drop the manifest AFTER the watcher is live (not part of the initial
    // scan) so we're testing live `add` detection, the path that was broken.
    const manifestPath = join(dir, 'asset.manifest');
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: 'My Cool Asset', build: 'b-42', installSize: 12_345 }),
    );

    await waitFor(() => sentEvents.length > 0);

    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].channel).toBe('fab-asset-discovered');
    expect(sentEvents[0].payload).toEqual({
      name: 'My Cool Asset',
      manifestPath,
      build: 'b-42',
      installSize: 12_345,
    });
  });

  it('ignores non-.manifest files dropped under the root', async () => {
    const root = mkdtempSync(join(tmp, 'vault-noise-'));
    mkdirSync(join(root, 'sub'), { recursive: true });

    start(root);

    writeFileSync(join(root, 'sub', 'readme.txt'), 'not a manifest');
    writeFileSync(join(root, 'sub', 'thumb.png'), 'binary');

    // Give the watcher real time to (wrongly) react; then assert silence.
    await new Promise((r) => setTimeout(r, 500));
    expect(sentEvents).toHaveLength(0);
  });

  it('falls back to the manifest basename when name is absent/invalid', async () => {
    const root = mkdtempSync(join(tmp, 'vault-noname-'));
    start(root);

    const manifestPath = join(root, 'Fallback.manifest');
    // `name` is a number, not a string → coerced to undefined → basename used.
    writeFileSync(manifestPath, JSON.stringify({ name: 99, installSize: 'big' }));

    await waitFor(() => sentEvents.length > 0);

    expect(sentEvents).toHaveLength(1);
    const payload = sentEvents[0].payload as Record<string, unknown>;
    expect(payload.name).toBe('Fallback');
    expect(payload.manifestPath).toBe(manifestPath);
    // installSize was a string → coerced away.
    expect(payload.installSize).toBeUndefined();
    expect(payload.build).toBeUndefined();
  });
});

describe('start() — missing-root handling', () => {
  it('returns a typed not-found instead of reporting a successful watch', () => {
    const missing = join(tmp, 'does', 'not', 'exist');
    const res = start(missing);
    expect(res).toEqual({ error: 'not-found', root: missing });
    // No watcher should have been created for a non-existent path.
  });

  it('returns not-found when the root is a file, not a directory', () => {
    const filePath = join(tmp, 'a-file-not-a-dir');
    writeFileSync(filePath, 'x');
    const res = start(filePath);
    expect(res).toEqual({ error: 'not-found', root: filePath });
  });
});

describe('start() — idempotency', () => {
  it('returns the same root and does not re-create the watcher for the same path', async () => {
    const root = mkdtempSync(join(tmp, 'vault-idem-'));
    const first = start(root);
    const second = start(root);
    expect(first).toEqual({ watching: root });
    expect(second).toEqual({ watching: root });

    // Sanity: a manifest dropped once should yield exactly one event, proving
    // the second start() did not stack a second watcher on the same root.
    const manifestPath = join(root, 'once.manifest');
    writeFileSync(manifestPath, JSON.stringify({ name: 'Once' }));
    await waitFor(() => sentEvents.length > 0);
    // Settle, then confirm no duplicate from a second watcher.
    await new Promise((r) => setTimeout(r, 300));
    expect(sentEvents).toHaveLength(1);
  });
});

describe('parseManifest', () => {
  it('extracts name/build/installSize from valid JSON', async () => {
    const p = join(tmp, 'valid.manifest');
    writeFileSync(p, JSON.stringify({ name: 'Pack', build: 'v3', installSize: 2048 }));
    await expect(parseManifest(p)).resolves.toEqual({
      name: 'Pack',
      build: 'v3',
      installSize: 2048,
    });
  });

  it('coerces wrong-typed fields to undefined', async () => {
    const p = join(tmp, 'wrongtypes.manifest');
    // name as number, build as object, installSize as string → all dropped.
    writeFileSync(p, JSON.stringify({ name: 1, build: { x: 1 }, installSize: '5' }));
    await expect(parseManifest(p)).resolves.toEqual({
      name: undefined,
      build: undefined,
      installSize: undefined,
    });
  });

  it('returns {} for malformed JSON', async () => {
    const p = join(tmp, 'malformed.manifest');
    writeFileSync(p, '{ not valid json ');
    await expect(parseManifest(p)).resolves.toEqual({});
  });

  it('returns {} for a missing file', async () => {
    const p = join(tmp, 'nope-does-not-exist.manifest');
    await expect(parseManifest(p)).resolves.toEqual({});
  });
});

describe('defaultVaultPath', () => {
  const realPlatform = process.platform;

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('uses LOCALAPPDATA\\EpicGamesLauncher\\VaultCache on win32', () => {
    setPlatform('win32');
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = join('C:', 'Users', 'x', 'AppData', 'Local');
    try {
      const p = defaultVaultPath();
      expect(p.endsWith(join('EpicGamesLauncher', 'VaultCache'))).toBe(true);
      expect(p.includes('Local')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });

  it('uses Application Support/Epic/.../VaultCache on darwin', () => {
    setPlatform('darwin');
    const p = defaultVaultPath();
    expect(p.endsWith(join('Application Support', 'Epic', 'EpicGamesLauncher', 'VaultCache'))).toBe(
      true,
    );
  });

  it('uses ~/Epic/VaultCache on linux/other', () => {
    setPlatform('linux');
    const p = defaultVaultPath();
    expect(p.endsWith(join('Epic', 'VaultCache'))).toBe(true);
    expect(p.includes('Application Support')).toBe(false);
  });
});
