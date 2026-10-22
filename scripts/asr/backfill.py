#!/usr/bin/env python
"""Whisper backfill over the Omnidex course library.

Transcribes every course video that has no subtitle sibling and writes a standard
`<video>.srt` sidecar next to it, which the course scanner ingests like any shipped
subtitle. Resume-safe: re-running skips anything that already has a sidecar. Creating
a STOP file next to this script halts cleanly between videos.

Foreign-language lessons also get a `<video>.en.srt` from Whisper's own X->English
speech-translation task — audio straight to English, so no transcription error is
inherited by a second text-translation model, and no extra dependency is needed. A
rerun adds English sidecars to lessons transcribed before this existed, using the
languages recorded in the manifest.

Co-residency guard (LlamaOptimize invariant: GPU batch jobs must not co-reside with a
loaded llama-swap main): total VRAM is sampled before every video; when it climbs past
PAUSE_TOTAL_MB the model is unloaded and the run waits for two consecutive clear
samples (so a llama-swap unload->load gap can't fake a free GPU). Unreadable nvidia-smi
counts as busy — the guard fails closed.

Never overwrites: a video is skipped if any subtitle sibling exists at planning time,
again right before transcription (fresh directory listing), and the exact output path
is checked immediately before the atomic write.

Usage:
  python backfill.py --db "%APPDATA%/omnidex/omnidex.db" [--limit N] [--match SUBSTR]
"""

import argparse
import datetime
import json
import os
import sqlite3
import subprocess
import sys
import time

VIDEO_EXTS = ('.mp4', '.mkv', '.webm', '.avi', '.mov')
SUB_EXTS = ('.srt', '.vtt')
HOTWORDS = (
    'Unreal Engine, Niagara, Nanite, Lumen, Chaos, Blueprint, MetaHuman, Quixel, Megascans, '
    'Sequencer, Control Rig, Gameplay Ability System, AbilitySystemComponent, GameplayEffect, '
    'AttributeSet, GameplayTag, ZBrush, Substance Painter, Houdini, Maya, Blender, retopology, '
    'PBR, normal map, rigging, skinning, animation blueprint, material instance, render target'
)
STOP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'STOP')
# A llama-swap main loads 10+ GB; whisper (~4-5 GB) plus desktop stays under 10 GB total.
PAUSE_TOTAL_MB = 10_000
# Desktop-only level; only reachable with whisper unloaded.
RESUME_TOTAL_MB = 4_500
# Whisper guesses a language for music and room tone too (a run of these scored as
# Nynorsk). Below this confidence the audio is treated as English and the translate
# pass is skipped, so noise can't cost a second decode.
MIN_LANG_PROB = 0.6


def log(line):
    print(f'{datetime.datetime.now():%H:%M:%S} {line}', flush=True)


def gpu_used_mb():
    """Total VRAM in use (MiB), or None when nvidia-smi is unavailable/unparseable.

    Total memory.used is reliable under Windows WDDM; per-process figures are not
    (nvidia-smi reports them as [N/A] on GeForce cards).
    """
    try:
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.used', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=15,
        )
        if out.returncode != 0:
            return None
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return None


def gpu_busy():
    used = gpu_used_mb()
    return used is None or used > PAUSE_TOTAL_MB  # fail closed


def wait_for_free_gpu():
    """Block until two consecutive samples read desktop-only VRAM. False on STOP."""
    clear = 0
    while True:
        if os.path.exists(STOP_FILE):
            return False
        used = gpu_used_mb()
        if used is not None and used < RESUME_TOTAL_MB:
            clear += 1
            if clear >= 2:
                return True
            time.sleep(5)
        else:
            if clear or used is None:
                log(f'waiting for GPU (used={used} MiB)')
            clear = 0
            time.sleep(60)


UNLISTABLE = object()


def sidecar_exists(video_path, dir_cache):
    """True if any .srt/.vtt in the video's folder belongs to this video.

    Matches `<stem>.` prefixes only, so `Lesson 10.srt` cannot suppress `Lesson 1.mp4`,
    while `X.srt`, `X.en_US.vtt`, and this script's own `X.mp4.srt` all still match.
    An unlistable folder fails closed (treated as subtitled, skipped, logged once).
    """
    folder = os.path.dirname(video_path)
    if folder not in dir_cache:
        try:
            dir_cache[folder] = os.listdir(folder)
        except OSError as e:
            log(f'ERROR cannot list {folder}: {e} — skipping its videos')
            dir_cache[folder] = UNLISTABLE
    if dir_cache[folder] is UNLISTABLE:
        return True
    stem = os.path.splitext(os.path.basename(video_path))[0].lower() + '.'
    for name in dir_cache[folder]:
        low = name.lower()
        if low.endswith(SUB_EXTS) and low.startswith(stem):
            return True
    return False


def srt_ts(seconds):
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def words_to_cues(segments, max_len=7.0, max_gap=1.0):
    """Re-chunk word timestamps into sentence-ish cues; fall back to whole segments."""
    cues, buf = [], []

    def flush():
        if buf:
            cues.append((buf[0].start, buf[-1].end, ''.join(w.word for w in buf).strip()))
            buf.clear()

    for seg in segments:
        words = getattr(seg, 'words', None)
        if not words:
            if seg.text.strip():
                cues.append((seg.start, seg.end, seg.text.strip()))
            continue
        for w in words:
            if buf and (w.start - buf[-1].end > max_gap or w.start - buf[0].start > max_len):
                flush()
            buf.append(w)
            if w.word.rstrip().endswith(('.', '?', '!')) and w.end - buf[0].start >= 2.0:
                flush()
    flush()
    return cues


def write_srt(path, cues):
    tmp = f'{path}.tmp'
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            for i, (start, end, text) in enumerate(cues, 1):
                f.write(f'{i}\n{srt_ts(start)} --> {srt_ts(end)}\n{text}\n\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def main():
    # Redirected stdout on Windows defaults to cp1252; course paths are full of
    # characters it cannot encode, and a logging crash must never kill the run.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')

    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--limit', type=int, default=0, help='stop after N videos (0 = all)')
    ap.add_argument('--match', default='', help='only videos whose path contains this substring')
    ap.add_argument('--plan-only', action='store_true',
                    help='print the job list and exit — no model load, no GPU')
    # Transcription of a freshly scanned library is days of GPU time. Translation
    # is hours. Without this the few hundred foreign-language lessons queue behind
    # every untranscribed video in the library and never get reached.
    ap.add_argument('--only', choices=('transcribe', 'translate'), default=None,
                    help='run just one kind of job')
    ap.add_argument('--manifest', default=os.path.join(
        os.environ.get('APPDATA', '.'), 'omnidex', 'logs', 'whisper-backfill-manifest.jsonl'))
    args = ap.parse_args()

    manifest_dir = os.path.dirname(args.manifest)
    if manifest_dir:
        os.makedirs(manifest_dir, exist_ok=True)

    def manifest(entry):
        with open(args.manifest, 'a', encoding='utf-8') as mf:
            mf.write(json.dumps(entry) + '\n')

    con = sqlite3.connect(f'file:{args.db}?mode=ro', uri=True, timeout=30)
    rows = con.execute(
        "SELECT abs_path FROM course_files WHERE kind='video' ORDER BY asset_id, rel_path"
    ).fetchall()
    con.close()

    # Languages detected by earlier runs. Without this a rerun would skip every
    # already-transcribed lesson, so the foreign-language ones could never pick up
    # an English sidecar. Older entries predate lang_prob and are trusted.
    known_lang = {}
    try:
        with open(args.manifest, encoding='utf-8') as mf:
            for line in mf:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                # A translate entry is keyed on the same video and says lang='en'; let
                # it overwrite and a deleted .en.srt could never be rebuilt. Silent
                # clips are dropped too: Whisper still names a language for room tone
                # (37 timelapses came back Nynorsk) and there is nothing to translate.
                if e.get('lang') and not e.get('translated_from') and not e.get('no_speech'):
                    known_lang[e['video']] = (e['lang'], e.get('lang_prob', 1.0))
    except OSError:
        pass

    dir_cache = {}
    work, missing = [], 0
    for (path,) in dict.fromkeys(rows):
        if args.match and args.match.lower() not in path.lower():
            continue
        if not path.lower().endswith(VIDEO_EXTS):
            continue
        if not os.path.exists(path):
            # Real deletions and >MAX_PATH casualties both land here; record, don't vanish.
            missing += 1
            manifest({'video': path, 'skipped': 'not-found (deleted or MAX_PATH?)'})
            continue
        if not sidecar_exists(path, dir_cache):
            work.append((path, 'transcribe'))
            continue
        lang, prob = known_lang.get(path, ('en', 1.0))
        if lang != 'en' and prob >= MIN_LANG_PROB and not os.path.exists(f'{path}.en.srt'):
            work.append((path, 'translate'))
    if args.only:
        work = [j for j in work if j[1] == args.only]
    n_tx = sum(1 for _, t in work if t == 'transcribe')
    log(f'{len(rows)} videos in DB, {n_tx} need transcription, '
        f'{len(work) - n_tx} need English translation, {missing} missing on disk')
    if args.limit:
        work = work[: args.limit]
    if args.plan_only:
        for path, t in work:
            log(f'{t:10s} {known_lang.get(path, ("en", 1.0))[0]}  {path}')
        return

    # ctranslate2 loads cuBLAS/cuDNN at runtime; point it at the pip-installed wheels.
    nvidia_dir = os.path.join(os.path.dirname(os.path.dirname(sys.executable)),
                              'Lib', 'site-packages', 'nvidia')
    for sub in ('cublas', 'cudnn'):
        p = os.path.join(nvidia_dir, sub, 'bin')
        if os.path.isdir(p):
            os.add_dll_directory(p)
            os.environ['PATH'] = p + os.pathsep + os.environ.get('PATH', '')

    from faster_whisper import BatchedInferencePipeline, WhisperModel

    model = pipe = None

    def unload():
        nonlocal model, pipe
        model = pipe = None
        import gc
        gc.collect()

    def load_when_free():
        """Wait for a free GPU, then load; re-enter the wait if the load itself fails."""
        nonlocal model, pipe
        while True:
            if not wait_for_free_gpu():
                return False
            try:
                log('loading large-v3 (float16)...')
                model = WhisperModel('large-v3', device='cuda', compute_type='float16')
                pipe = BatchedInferencePipeline(model=model)
                return True
            except Exception as e:
                log(f'model load failed ({e}), backing off')
                unload()
                time.sleep(60)

    def asr(path, out, task, language=None):
        """Decode one video to `out`. `task='translate'` emits English from any audio."""
        segments, info = pipe.transcribe(
            path, batch_size=12, hotwords=HOTWORDS, word_timestamps=True,
            task=task, language=language)
        cues = words_to_cues(segments)
        no_speech = not cues
        if no_speech:
            # Marker cue so the sidecar check caches the result instead of
            # re-decoding silent/music-only videos on every rerun.
            cues = [(0.0, 0.5, '[no speech]')]
        write_srt(out, cues)
        return info, cues, no_speech

    done = translated = failed = skipped = 0
    audio_s = wall_s = 0.0
    halted = not load_when_free()
    for i, (path, task) in enumerate(work):
        if halted or os.path.exists(STOP_FILE):
            halted = True
            log('STOP requested, halting')
            break
        if gpu_busy():
            log(f'PAUSED — VRAM above {PAUSE_TOTAL_MB} MiB, freeing the GPU')
            unload()
            if not load_when_free():
                halted = True
                log('STOP requested while paused, halting')
                break
            log('resumed')
        try:
            t0 = time.time()
            lang, prob = known_lang.get(path, ('en', 1.0))
            if task == 'transcribe':
                # A subtitle may have appeared since planning (user, scanner, second run):
                # re-list the folder now, and never replace an existing file.
                dir_cache.pop(os.path.dirname(path), None)
                out = f'{path}.srt'
                if sidecar_exists(path, dir_cache) or os.path.exists(out):
                    skipped += 1
                    log(f'[{i + 1}/{len(work)}] skip — subtitle appeared: {path}')
                    continue
                info, cues, no_speech = asr(path, out, 'transcribe')
                lang, prob = info.language, info.language_probability
                if no_speech:
                    lang = 'en'  # nothing said, nothing to translate
                dt = time.time() - t0
                done += 1
                audio_s += info.duration
                wall_s += dt
                manifest({
                    'video': path, 'srt': out, 'cues': len(cues), 'lang': lang,
                    'lang_prob': round(prob, 3), 'no_speech': no_speech,
                    'audio_s': round(info.duration, 1), 'wall_s': round(dt, 1),
                    'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                })
                log(f'[{i + 1}/{len(work)}] x{info.duration / max(dt, 0.1):.0f} '
                    f'{len(cues)} cues  {lang}  {path}')

            # Second decode with task='translate': Whisper emits English directly from
            # the source audio, so nothing is lost to an intermediate transcript. Only
            # a confidently foreign track earns it.
            en_out = f'{path}.en.srt'
            if lang != 'en' and prob >= MIN_LANG_PROB and not os.path.exists(en_out):
                t1 = time.time()
                einfo, en_cues, _ = asr(path, en_out, 'translate', lang)
                dt = time.time() - t1
                translated += 1
                wall_s += dt
                manifest({
                    'video': path, 'srt': en_out, 'cues': len(en_cues), 'lang': 'en',
                    'translated_from': lang, 'audio_s': round(einfo.duration, 1),
                    'wall_s': round(dt, 1),
                    'ts': datetime.datetime.now().isoformat(timespec='seconds'),
                })
                log(f'[{i + 1}/{len(work)}] {lang}->en  {len(en_cues)} cues  {path}')
        except KeyboardInterrupt:
            log('interrupted, halting')
            break
        except Exception as e:
            failed += 1
            log(f'ERROR {path}: {e}')
            manifest({'video': path, 'error': str(e)})
        if (i + 1) % 200 == 0:
            log(f'MILESTONE {done} done, {translated} translated, {failed} failed, '
                f'{skipped} skipped, {audio_s / 3600:.1f} audio-h in {wall_s / 3600:.2f} h')
    log(f'DONE {done} transcribed, {translated} translated to English, {failed} failed, '
        f'{skipped} skipped, {audio_s / 3600:.1f} audio-h in {wall_s / 3600:.2f} wall-h')


if __name__ == '__main__':
    main()
