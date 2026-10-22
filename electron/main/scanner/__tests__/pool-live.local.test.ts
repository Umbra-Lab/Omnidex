import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractThumbnailsIsolated } from '../thumbnail-pool';

/**
 * LOCAL ONLY — not for CI. Drives the pool with its REAL child source against
 * real `.uasset` files on this machine, to prove the isolation actually still
 * produces thumbnails rather than silently returning null for everything.
 */
const LIST = process.env.POOL_LIVE_LIST;

describe.skipIf(!LIST || !existsSync(LIST))('pool against the real addon', () => {
  it('produces a PNG for a file that has an embedded thumbnail', async () => {
    const files = JSON.parse(readFileSync(LIST as string, 'utf8')) as string[];
    const outDir = join(tmpdir(), 'omnidex-pool-live');
    mkdirSync(outDir, { recursive: true });

    const got: [string, string | null][] = [];
    const crashed: string[] = [];
    await extractThumbnailsIsolated({
      targets: files,
      outDir,
      size: 256,
      concurrency: 4,
      onResult: (p, png) => got.push([p, png]),
      onCrash: (p) => crashed.push(p),
    });

    for (const [p, png] of got) console.log(png ? 'PNG ' : 'null', p.slice(-60));
    console.log('crashed:', crashed.length);

    expect(got).toHaveLength(files.length);
    // Direct calls to the addon produce a PNG for at least one of these, so the
    // pool must too. All-null would mean the isolation broke extraction.
    expect(got.filter(([, png]) => png !== null).length).toBeGreaterThan(0);
  }, 120_000);
});
