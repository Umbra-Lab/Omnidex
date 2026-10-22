# Transcribe and translate a course

Courses that ship no subtitles get them from Whisper. Foreign-language courses additionally get an English track. Everything runs locally on the GPU — no API, no upload.

`scripts/asr/backfill.py` writes a standard `<video>.srt` beside each video, which the scanner then ingests like any shipped subtitle.

## Set up the environment

```bash
python -m venv "$LOCALAPPDATA/omnidex-asr"
```

```bash
"$LOCALAPPDATA/omnidex-asr/Scripts/python.exe" -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
```

The two `nvidia-*` packages ship the cuBLAS and cuDNN binaries CTranslate2 loads at runtime; the script adds their `bin` directories to the DLL search path itself.

## See the work before doing any

```bash
"$LOCALAPPDATA/omnidex-asr/Scripts/python.exe" scripts/asr/backfill.py --db "$APPDATA/omnidex/omnidex.db" --plan-only
```

```
25785 videos in DB, 8886 need transcription, 339 need English translation, 0 missing on disk
```

`--plan-only` loads no model and touches no GPU. Run it first — transcription and translation differ in cost by two orders of magnitude.

## Run it

```bash
"$LOCALAPPDATA/omnidex-asr/Scripts/python.exe" scripts/asr/backfill.py --db "$APPDATA/omnidex/omnidex.db" --only translate
```

| Flag | Effect |
|---|---|
| `--only transcribe\|translate` | Run one kind of job |
| `--limit N` | Stop after N videos |
| `--match SUBSTR` | Only videos whose path contains this |
| `--plan-only` | Print the plan and exit |

```admonish tip title="Split the two jobs"
Transcribing a freshly scanned library is days of GPU time; translating a few hundred foreign lessons is hours. Without `--only`, the translations queue behind every untranscribed video in path order and are never reached.
```

## The GPU co-residency guard

The script samples total VRAM before every video. If it climbs past **10,000 MiB** the model is unloaded and the run waits for two consecutive samples below **4,500 MiB** before reloading.

Two samples, not one, so a llama-swap unload-then-load gap cannot look like a free GPU. An unreadable `nvidia-smi` counts as busy — the guard fails closed.

```admonish warning title="A loaded LLM will block the run indefinitely"
If a llama-swap main is resident, the script waits rather than competing for VRAM. That is intended. Check with:

`nvidia-smi --query-gpu=memory.used --format=csv,noheader`

The run resumes on its own once the GPU frees.
```

Create a file named `STOP` beside the script to halt cleanly between videos.

## How translation works

For a lesson whose audio is not English, the script runs a second decode with Whisper's `task='translate'`, writing `<video>.en.srt`.

This translates **from the source audio**, not from the transcript. A transcript-then-translate pipeline compounds every ASR error into the translation; going straight from audio does not, and needs no second model.

The scanner pairs `X.en.srt` to the same lesson as `X.srt`, and `subtitlePathForVideo` prefers the English one.

```admonish note title="Silence gets a language too"
Whisper names a language for room tone. On one library, 37 of 39 "Norwegian Nynorsk" detections were silent sculpting timelapses. Entries marked `no_speech` are excluded from translation, and a detection below 0.6 confidence is treated as English — there is nothing to translate either way.
```

## Never overwrites

A video is skipped if any subtitle sibling exists — checked at planning time, again from a fresh directory listing immediately before transcription, and once more on the exact output path before the write. Writes go to a temp file and are renamed atomically.

Re-running is always safe.

## Index the results

New `.srt` files are inert until a scan picks them up:

```bash
pnpm refresh-scans
```

## Check what happened

Every job appends to `%APPDATA%/omnidex/logs/whisper-backfill-manifest.jsonl`:

```json
{"video":"...","srt":"...","cues":412,"lang":"ru","lang_prob":0.998,"audio_s":1840.2,"wall_s":94.1}
```

The manifest is also how a later run knows which already-transcribed lessons are foreign-language and still need an English track.

## Next steps

- [Learn: courses and transcripts](../subsystems/learn.md) — how cues are paired and searched
- [Run a data operation](run-a-data-operation.md) — indexing the new sidecars
