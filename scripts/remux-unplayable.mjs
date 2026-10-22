// Remux course videos Chromium cannot decode into MP4 it can.
//
//   node scripts/remux-unplayable.mjs [--dry-run] [--course <substr>] [--limit N]
//
// Why this is a script and not a feature: the whole problem is 44 files in one
// course. Building an on-demand remux pipeline into the app would mean bundling
// ffmpeg (~80 MB on the installer) and maintaining a cache, to solve something
// a one-off pass fixes in about six minutes. Revisit that only if unplayable
// containers start showing up in courses you actually acquire.
//
// This is a REMUX, not a re-encode: `-c copy` lifts the existing H.264/AAC
// streams into an MP4 container untouched. No quality loss, no GPU, and it runs
// at disk speed — measured 1660 MB in 22s. Output is usually slightly SMALLER
// than the input, because MPEG-TS spends ~2-3% on packet overhead MP4 does not.
//
// The originals are never deleted. The manifest builder prefers the .mp4 when
// both exist (see course-manifest.ts), so a rescan will not double the chapter
// list, and you can delete the sources yourself once you are satisfied.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Containers Chromium refuses in a <video src>. Measured, not assumed:
 * `canPlayType('video/mp2t')` is '' and a real transport stream fails with
 * DEMUXER_ERROR_COULD_NOT_OPEN, while .mkv, .webm and .mov all play.
 */
const UNPLAYABLE = new Set(['.ts', '.m2ts', '.mts']);

/**
 * Codecs MP4 can legally carry. A stream copy of anything else produces a file
 * that is technically an MP4 and plays nowhere, so those are skipped loudly
 * rather than converted into a silent corruption.
 */
const MP4_VIDEO = new Set(['h264', 'hevc', 'h265', 'av1', 'mpeg4']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac']);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};

const DRY_RUN = flag('--dry-run');
const COURSE = value('--course');
const LIMIT = Number(value('--limit') ?? 0) || 0;

const dbPath = process.env.ORACLE_DB ?? join(process.env.APPDATA ?? '.', 'omnidex', 'omnidex.db');

function must(cmd) {
  const r = spawnSync(cmd, ['-version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`${cmd} not found on PATH. Install ffmpeg (it ships ffprobe too) and re-run.`);
    process.exit(1);
  }
  return r.stdout.split('\n')[0];
}

/** Codec names for a file, or null when it cannot be probed. */
function probe(path) {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 22 },
  );
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const streams = j.streams ?? [];
    return {
      video: streams.find((s) => s.codec_type === 'video')?.codec_name ?? null,
      audio: streams.find((s) => s.codec_type === 'audio')?.codec_name ?? null,
      duration: Number(j.format?.duration ?? 0),
    };
  } catch {
    return null;
  }
}

function remux(src, dest) {
  return new Promise((resolve) => {
    const p = spawn(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        src,
        '-c',
        'copy',
        // Explicit, because the temp name ends `.partial` and ffmpeg otherwise
        // infers the muxer from the extension ("Unable to choose an output
        // format"). Naming the temp `.partial.mp4` would fix the inference and
        // create a worse problem: a leftover from an interrupted run would look
        // like a real lesson to the scanner.
        '-f',
        'mp4',
        // Moves the moov atom to the front. Without it a player must read to
        // the end of the file before it can seek — which, on a 1.6 GB lesson
        // served over the asset protocol, is the difference between instant
        // scrubbing and none.
        '-movflags',
        '+faststart',
        dest,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    p.stderr.on('data', (c) => {
      err += c.toString();
    });
    p.on('close', (code) => resolve({ code, err: err.trim() }));
  });
}

const mb = (n) => (n / 1048576).toFixed(0).padStart(6);

async function main() {
  console.log(must('ffmpeg'));
  must('ffprobe');

  if (!existsSync(dbPath)) {
    console.error(`Library DB not found at ${dbPath}`);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(
      `SELECT f.abs_path, f.size_bytes, a.name AS course
         FROM course_files f JOIN assets a ON a.id = f.asset_id
        WHERE f.kind = 'video'
        ORDER BY a.name, f.rel_path`,
    )
    .all();
  db.close();

  let work = rows.filter((r) => UNPLAYABLE.has(extname(r.abs_path).toLowerCase()));
  if (COURSE) work = work.filter((r) => r.course.toLowerCase().includes(COURSE.toLowerCase()));

  const courses = new Set(work.map((r) => r.course));
  const totalBytes = work.reduce((n, r) => n + (r.size_bytes ?? 0), 0);
  console.log(
    `${work.length} unplayable video(s) across ${courses.size} course(s), ` +
      `${(totalBytes / 1e9).toFixed(1)} GB`,
  );
  if (work.length === 0) return;
  if (LIMIT) work = work.slice(0, LIMIT);

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let bytesIn = 0;
  let bytesOut = 0;
  const started = Date.now();

  for (const [i, row] of work.entries()) {
    const src = row.abs_path;
    const dest = join(dirname(src), `${basename(src, extname(src))}.mp4`);
    const label = `[${i + 1}/${work.length}] ${basename(src).slice(0, 62)}`;

    if (!existsSync(src)) {
      console.log(`${label}  SKIP (source gone)`);
      skipped++;
      continue;
    }
    // Resume-safe: a finished output is never redone, and never overwritten.
    if (existsSync(dest)) {
      console.log(`${label}  SKIP (mp4 already there)`);
      skipped++;
      continue;
    }

    const info = probe(src);
    if (!info) {
      console.log(`${label}  SKIP (unprobeable)`);
      skipped++;
      continue;
    }
    // The guard that matters: copying a codec MP4 cannot carry yields a file
    // that opens nowhere. Say so instead of producing it.
    if (!MP4_VIDEO.has(info.video) || (info.audio && !MP4_AUDIO.has(info.audio))) {
      console.log(`${label}  SKIP (needs re-encode: ${info.video}/${info.audio})`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`${label}  would remux (${info.video}/${info.audio}, ${mb(row.size_bytes)} MB)`);
      continue;
    }

    // Write to a temp name and rename on success, so an interrupted run can
    // never leave a half-written .mp4 that the resume check would then skip.
    const tmp = `${dest}.partial`;
    const t0 = Date.now();
    const { code, err } = await remux(src, tmp);
    if (code !== 0) {
      rmSync(tmp, { force: true });
      console.log(`${label}  FAILED: ${err.split('\n')[0]}`);
      failed++;
      continue;
    }

    // Verify before committing: a non-zero exit is not proof the output is
    // usable, and a truncated remux would otherwise be indistinguishable from
    // a good one until someone tried to watch it.
    const out = probe(tmp);
    const drift = out ? Math.abs(out.duration - info.duration) : Infinity;
    if (!out || !out.video || drift > 1) {
      rmSync(tmp, { force: true });
      console.log(`${label}  FAILED verification (duration drift ${drift.toFixed(1)}s)`);
      failed++;
      continue;
    }

    renameSync(tmp, dest);
    const inSize = statSync(src).size;
    const outSize = statSync(dest).size;
    bytesIn += inSize;
    bytesOut += outSize;
    done++;
    const secs = (Date.now() - t0) / 1000;
    console.log(
      `${label}  ok  ${mb(inSize)} -> ${mb(outSize)} MB  ${secs.toFixed(1)}s ` +
        `(${(inSize / 1048576 / Math.max(secs, 0.1)).toFixed(0)} MB/s)`,
    );
  }

  const mins = (Date.now() - started) / 60000;
  console.log(
    `\nDONE ${done} remuxed, ${skipped} skipped, ${failed} failed in ${mins.toFixed(1)} min`,
  );
  if (done > 0) {
    console.log(
      `  ${(bytesIn / 1e9).toFixed(1)} GB in -> ${(bytesOut / 1e9).toFixed(1)} GB out ` +
        `(originals kept; delete them to reclaim ${(bytesIn / 1e9).toFixed(1)} GB)`,
    );
    console.log('  Run a scan so Learn picks up the .mp4 files.');
  }
}

await main();
