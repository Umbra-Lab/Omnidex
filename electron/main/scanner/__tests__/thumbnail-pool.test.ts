import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractThumbnailsIsolated } from '../thumbnail-pool';

/**
 * The child is swapped for a stub so these run without the native addon. The
 * stub reproduces the only behaviour that matters: a path containing `KILL`
 * takes the process down mid-job, exactly as a Rust allocation abort does.
 */
const STUB_CHILD = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.includes('KILL')) process.exit(134);      // what abort() looks like
  if (line.includes('NOTHUMB')) return process.stdout.write('null\\n');
  process.stdout.write(JSON.stringify(line + '.png') + '\\n');
});
`;

const run = async (targets: string[], concurrency = 1, signal?: AbortSignal) => {
  const results: [string, string | null][] = [];
  const crashes: string[] = [];
  await extractThumbnailsIsolated({
    targets,
    outDir: 'unused',
    size: 64,
    concurrency,
    signal,
    childSource: STUB_CHILD,
    onResult: (p, png) => results.push([p, png]),
    onCrash: (p) => crashes.push(p),
  });
  return { results, crashes };
};

describe('extractThumbnailsIsolated', () => {
  it('extracts every file when nothing crashes', async () => {
    const { results, crashes } = await run(['a', 'b', 'c']);
    expect(results).toEqual([
      ['a', 'a.png'],
      ['b', 'b.png'],
      ['c', 'c.png'],
    ]);
    expect(crashes).toEqual([]);
  });

  it('survives a file that kills the extractor and keeps going', async () => {
    // In-process this is unrecoverable: a Rust abort ends the scan here and the
    // remaining files are never seen.
    const { results, crashes } = await run(['a', 'KILL-me', 'b', 'c']);
    expect(crashes).toEqual(['KILL-me']);
    expect(results).toEqual([
      ['a', 'a.png'],
      ['KILL-me', null],
      ['b', 'b.png'],
      ['c', 'c.png'],
    ]);
  });

  it('survives back-to-back killers', async () => {
    const { results, crashes } = await run(['KILL-1', 'KILL-2', 'ok']);
    expect(crashes).toEqual(['KILL-1', 'KILL-2']);
    expect(results.at(-1)).toEqual(['ok', 'ok.png']);
  });

  it('reports a clean extractor failure as no thumbnail, not a crash', async () => {
    const { results, crashes } = await run(['NOTHUMB-x']);
    expect(results).toEqual([['NOTHUMB-x', null]]);
    expect(crashes).toEqual([]);
  });

  it('covers every file across parallel lanes', async () => {
    const targets = Array.from({ length: 24 }, (_, i) => (i % 7 === 3 ? `KILL-${i}` : `f${i}`));
    const { results } = await run(targets, 4);
    expect(results.map(([p]) => p).sort()).toEqual([...targets].sort());
  });

  it('stops early when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { results } = await run(['a', 'b'], 1, ac.signal);
    expect(results).toEqual([]);
  });

  it('does nothing for an empty target list', async () => {
    const { results } = await run([]);
    expect(results).toEqual([]);
  });

  it('recovers a file that only died because another lane took the memory', async () => {
    // Dies the first time it is seen, succeeds when retried alone — which is
    // how a merely-unlucky file behaves once it is not competing for headroom.
    const FLAKY_CHILD = `
      const fs = require('node:fs');
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (line.includes('FLAKY')) {
          const seen = fs.existsSync(process.env.FLAG);
          if (!seen) { fs.writeFileSync(process.env.FLAG, '1'); process.exit(134); }
          return process.stdout.write(JSON.stringify(line + '.png') + '\\n');
        }
        process.stdout.write(JSON.stringify(line + '.png') + '\\n');
      });
    `;
    const flag = join(tmpdir(), `omnidex-flaky-${process.pid}-${Date.now()}`);
    const results: [string, string | null][] = [];
    const crashes: string[] = [];
    process.env.FLAG = flag;
    try {
      await extractThumbnailsIsolated({
        targets: ['a', 'FLAKY-one', 'b'],
        outDir: 'unused',
        size: 64,
        concurrency: 2,
        childSource: FLAKY_CHILD,
        onResult: (p, png) => results.push([p, png]),
        onCrash: (p) => crashes.push(p),
      });
    } finally {
      rmSync(flag, { force: true });
      process.env.FLAG = undefined;
    }
    // Not reported as a crasher, and its thumbnail is not lost.
    expect(crashes).toEqual([]);
    expect(results).toContainEqual(['FLAKY-one', 'FLAKY-one.png']);
  });

  it('still reports a file that crashes even when retried alone', async () => {
    const { results, crashes } = await run(['a', 'KILL-always', 'b'], 2);
    expect(crashes).toEqual(['KILL-always']);
    expect(results).toContainEqual(['KILL-always', null]);
  });
});
