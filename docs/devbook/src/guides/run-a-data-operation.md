# Run a data operation

Every data operation runs from the UI and from the command line, backed by the same service. The CLI form boots Electron through `electron/main/index.ts`, shares the normal boot path (database open, migrations, IPC registration), runs the job, and exits.

```admonish warning title="Build first"
CLI flags run the built output in `out/`, not your source tree. Run `pnpm build` after any main-process change or the operation runs the old code.
```

## The operations

| Task | CLI | UI |
|---|---|---|
| Scan every active location | `pnpm refresh-scans` | Settings → Folders → **Scan all**, or Command Palette → **Refresh library** |
| Scan one location | — | Settings → Folders → **Scan** on the folder's row |
| Extract missing thumbnails | `pnpm extract-thumbs` | Runs automatically after each scan |
| Marketplace enrichment | `pnpm enrich-orbital` | Settings → Marketplace → **Enrich now** |
| FAB library sync | `pnpm enrich-fab` | Settings → Marketplace → FAB Marketplace → **Sync now** |
| Backfill course sources | `pnpm backfill:course-sources` | — |

## Add a scan location

The setting that matters is **content format**, and the trap is where you point it.

A location with `content_format = 'course'` treats **each top-level folder as one course**. Point it at a folder of courses, never at a folder of categories:

```
D:/Courses/                     <-- WRONG. Nine disciplines become nine "courses".
├── Blender/                    <-- RIGHT. Add this.
├── Houdini/                    <-- RIGHT. And this.
└── ZBrush/                     <-- RIGHT. And this.
```

Adding the parent produces courses named after disciplines whose manifests flatten every lesson of every real course inside. There is no warning — the scan succeeds and indexes the wrong thing.

Check before committing:

```bash
pnpm smoke:scan "D:/Courses/Blender"
```

This prints what the walker would register and writes nothing.

## Scan a subset

`refreshAllScans` runs every location with `is_active = 1`. To scope a run, deactivate the rest — via the UI, or directly:

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.APPDATA+'/omnidex/omnidex.db');
db.prepare('UPDATE scan_locations SET is_active=0 WHERE id IN (1,2,3)').run();
"
```

Deactivating skips a location; it does not prune its assets.

```admonish danger title="Reactivate when you are done"
An inactive location is never re-scanned, so its rows go stale silently — packs deleted from disk keep appearing in the library. Turn them back on.
```

## Reading the log

```
[scan] walking D:/Library/.../Courses
[scan] walk done: 86 folders in 102.7s
[scan] diagnostics: 174 recorded
[scan] inserts done: 86 rows (4 new, 82 existing, 0 pruned) in 0.3s
[scan] backgrounding 36 thumbnail extractions
[refresh] OK [4] Courses (E:) — phase=Completed processed=86/86
[scan] thumbnails done: 36/36 in 3.0s (36 failed)
```

- **`diagnostics: N recorded`** — folders skipped with a reason. Check these before concluding the walker missed something.
- **`pruned`** — rows deleted because the folder is gone. A non-zero prune on a re-scan of an unchanged library is a bug.
- **`thumbnails done: N/N (M failed)`** — failures here are common and usually correct. `invalid thumbnail dimensions: 0x0` is what a BuiltData map or blueprint wrapper returns.

```admonish tip title="Thumbnails finish after the scan reports complete"
Extraction is backgrounded, so `phase=Completed` arrives before `thumbnails done`. A CLI run stays alive until both finish.
```

## Long runs

A full multi-terabyte scan takes minutes to hours. Redirect and background it:

```bash
pnpm refresh-scans > scan.log 2>&1
```

Then watch progress:

```bash
grep -E "^\[refresh\] (OK|->)" scan.log | tail -5
```

```admonish danger title="Never kill a scan mid-manifest"
Killing the process during the course-manifest phase leaves courses whose `course_files` rows were rebuilt but whose subtitles were not yet re-parsed. Because cues cascade from `course_files`, those courses lose their transcripts until the next complete scan.

Measured once: an interrupted scan dropped 109,667 cues. They came back on the next full run, because the `.srt` files on disk are the source of truth — but the library was searchable-but-wrong in between.
```

## Verify the result

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.APPDATA+'/omnidex/omnidex.db',{readOnly:true});
const q=s=>db.prepare(s).get().n;
console.log('courses ', q(\"SELECT COUNT(*) n FROM assets WHERE content_format='course'\"));
console.log('packs   ', q('SELECT COUNT(*) n FROM assets WHERE content_format IS NULL'));
console.log('videos  ', q(\"SELECT COUNT(*) n FROM course_files WHERE kind='video'\"));
console.log('cues    ', q('SELECT COUNT(*) n FROM transcript_cues'));
console.log('orphans ', q('SELECT COUNT(*) n FROM transcript_cues WHERE file_id NOT IN (SELECT id FROM course_files)'));
"
```

`orphans` must be `0`. Anything else means the cascade is not working.

## Next steps

- [The scanner](../subsystems/scanner.md) — what each phase does
- [Transcribe and translate a course](transcribe-a-course.md) — filling in missing subtitles
- [CLI flags](../reference/cli-flags.md) — the full flag list
