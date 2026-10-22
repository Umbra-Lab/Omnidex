import { Captions, CaptionsOff, Check, CircleSlash, Play, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useViewStatus } from '@/components/layout/StatusBar';
import { Input } from '@/components/ui/input';
import { AskPane } from '@/features/learn/AskPane';
import { trpc } from '@/ipc/trpc';
import { toAssetUrl } from '@/lib/assetUrl';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { subtitleStem, videoStem } from '@/lib/subtitleStem';

/**
 * Learn — an index that knows what is inside.
 *
 * This screen was a three-column grid of cards, each holding a book icon, a
 * truncated folder name, and the literal string "tutorial". Clicking one
 * called `shell.openFileLocation`: the app's answer to "I want to learn" was
 * Windows Explorer.
 *
 * It now reads the manifest the scanner writes — duration, video and chapter
 * counts, whether subtitles exist, how far through you are — plays lessons
 * in-app with the position persisted per file, and searches inside subtitle
 * cues rather than matching folder names.
 *
 * Subtitles are converted to WebVTT in main and mounted as a <track>.
 * Containers Chromium cannot decode (MPEG-TS, notably) fall back to an
 * explicit unsupported state with an external-player action.
 */

type ProgressFilter = 'all' | 'in_progress' | 'not_started' | 'completed';

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function LearnView() {
  const courses = trpc.courses.list.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const searching = debounced.length > 1;
  const hits = trpc.courses.searchTranscripts.useQuery(
    { query: debounced, limit: 80 },
    { enabled: searching },
  );

  const all = useMemo(() => courses.data ?? [], [courses.data]);

  const filtered = useMemo(() => {
    // An active transcript search narrows the list to courses that said it.
    const hitCourses = new Set((hits.data ?? []).map((h) => h.asset_id));
    return all.filter((c) => {
      if (searching && !hitCourses.has(c.id)) return false;
      const pct = c.percent_complete ?? 0;
      if (progressFilter === 'in_progress') return pct > 0 && pct < 100;
      if (progressFilter === 'not_started') return pct === 0;
      if (progressFilter === 'completed') return pct >= 100;
      return true;
    });
  }, [all, progressFilter, searching, hits.data]);

  const selected = selectedId ?? filtered[0]?.id ?? null;

  const totals = useMemo(
    () => ({
      seconds: all.reduce((n, c) => n + (c.duration_seconds ?? 0), 0),
      withSubs: all.filter((c) => c.subtitle_count > 0).length,
      unindexed: all.filter((c) => c.has_manifest === 0).length,
      sealed: all.filter((c) => c.video_count === 0 && c.archive_count > 0).length,
    }),
    [all],
  );

  const setViewStatus = useViewStatus((s) => s.setViewStatus);
  const resetViewStatus = useViewStatus((s) => s.resetViewStatus);
  useEffect(() => {
    setViewStatus({
      shown: filtered.length,
      selected: 0,
      viewMode: searching
        ? `${formatCount(hits.data?.length ?? 0)} transcript hits`
        : `${formatCount(totals.withSubs)} with subtitles`,
    });
  }, [setViewStatus, filtered.length, searching, hits.data, totals.withSubs]);
  useEffect(() => resetViewStatus, [resetViewStatus]);

  const bucket = (f: ProgressFilter) =>
    all.filter((c) => {
      const pct = c.percent_complete ?? 0;
      if (f === 'in_progress') return pct > 0 && pct < 100;
      if (f === 'not_started') return pct === 0;
      if (f === 'completed') return pct >= 100;
      return true;
    }).length;

  return (
    <div className="flex h-full w-full min-w-0">
      <nav
        aria-label="Learn filters"
        className="flex w-[220px] shrink-0 flex-col gap-1 border-r border-surface-800/60 bg-surface-925 px-2 py-3"
      >
        <h3 className="mt-1 px-2 pb-1 font-mono cap-9 font-semibold uppercase tracking-[0.18em] text-surface-500">
          Progress
        </h3>
        {(
          [
            ['all', 'All courses'],
            ['in_progress', 'In progress'],
            ['not_started', 'Not started'],
            ['completed', 'Completed'],
          ] as ReadonlyArray<readonly [ProgressFilter, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setProgressFilter(key)}
            className={cn(
              'flex h-7 items-center gap-2 rounded-md px-2 cap-12 transition-colors',
              progressFilter === key
                ? 'bg-surface-800/80 font-medium text-surface-50'
                : 'text-surface-300 hover:bg-surface-900',
            )}
          >
            <span className="flex-1 text-left">{label}</span>
            <span className="font-mono tabular-nums cap-10 text-surface-400">
              {formatCount(bucket(key))}
            </span>
          </button>
        ))}

        <h3 className="mt-4 px-2 pb-1 font-mono cap-9 font-semibold uppercase tracking-[0.18em] text-surface-500">
          Library
        </h3>
        <div className="flex flex-col gap-0.5 px-2 font-mono cap-10 text-surface-400">
          <span>{formatCount(all.length)} courses</span>
          <span>{formatDuration(totals.seconds)} total</span>
          <span>{formatCount(totals.withSubs)} with subtitles</span>
          {totals.unindexed > 0 ? (
            <span className="mt-2 text-warning-300">
              {formatCount(totals.unindexed)} not indexed — run a scan
            </span>
          ) : null}
          {totals.sealed > 0 ? (
            <span className="text-warning-300">{formatCount(totals.sealed)} still in archives</span>
          ) : null}
        </div>
      </nav>

      <section className="flex w-[420px] shrink-0 flex-col border-r border-surface-800/60 bg-surface-935">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-surface-800/60 px-3">
          <Search size={14} className="shrink-0 text-surface-400" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search inside transcripts…"
            className="h-8 border-0 bg-transparent px-0 focus-visible:ring-0"
            aria-label="Search transcripts"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="shrink-0 text-surface-400 hover:text-surface-100"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>

        {searching ? (
          <div className="shrink-0 border-b border-surface-800/60 bg-surface-900 px-3 py-1.5 font-mono cap-10 text-surface-400">
            {hits.isFetching
              ? 'Searching transcripts…'
              : `${formatCount(hits.data?.length ?? 0)} hits in ${formatCount(filtered.length)} courses`}
          </div>
        ) : null}

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {courses.isPending ? (
            <li className="p-4 cap-12 text-surface-400">Loading courses…</li>
          ) : filtered.length === 0 ? (
            <li className="p-4 cap-12 text-surface-400">
              {searching ? 'Nothing said that.' : 'No courses in this bucket.'}
            </li>
          ) : (
            filtered.map((c) => {
              const pct = Math.round(c.percent_complete ?? 0);
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    data-testid="course-row"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'flex w-full flex-col gap-1.5 border-b border-surface-800/40 px-3 py-2.5 text-left transition-colors',
                      c.id === selected ? 'bg-accent-500/10' : 'hover:bg-surface-900/60',
                    )}
                  >
                    <span
                      className="truncate cap-14 font-medium text-surface-50"
                      title={c.display_title ? `${c.display_title} — ${c.name}` : c.name}
                    >
                      {/* A folder called "7792580" is not a title. The scanner
                          recovers one from the folder inside; fall back to the
                          directory name, which is at least true. */}
                      {c.display_title ?? c.name}
                    </span>
                    <span className="truncate font-mono cap-10 text-surface-400">
                      {c.tutorial_source ? `${c.tutorial_source} · ` : ''}
                      {/* A course delivered as a 26-part RAR has 50 GB of real
                          material and nothing playable. "0 videos" would be a
                          lie; say what is actually true and what to do. */}
                      {c.video_count === 0 && c.archive_count > 0
                        ? `${formatCount(c.archive_count)} archives — extract to index`
                        : `${formatDuration(c.duration_seconds)} · ${formatCount(c.video_count)} videos${
                            c.chapter_count > 0 ? ` · ${formatCount(c.chapter_count)} chapters` : ''
                          }`}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="h-1 flex-1 overflow-hidden rounded-xs bg-surface-800">
                        <span
                          className="block h-1 rounded-xs bg-accent-500"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="font-mono tabular-nums cap-10 text-surface-400">{pct}%</span>
                      {c.subtitle_count > 0 ? (
                        <Captions size={12} className="text-success-500" />
                      ) : (
                        <CaptionsOff size={12} className="text-surface-600" />
                      )}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      {selected != null ? (
        <CourseDetail assetId={selected} transcriptQuery={searching ? debounced : null} />
      ) : (
        <div className="flex flex-1 items-center justify-center cap-12 text-surface-400">
          Select a course.
        </div>
      )}
    </div>
  );
}

function CourseDetail({
  assetId,
  transcriptQuery,
}: {
  readonly assetId: number;
  readonly transcriptQuery: string | null;
}) {
  const files = trpc.courses.files.useQuery(assetId);
  const course = trpc.courses.get.useQuery(assetId);
  const hits = trpc.courses.searchTranscripts.useQuery(
    { query: transcriptQuery ?? '', limit: 40 },
    { enabled: Boolean(transcriptQuery) },
  );

  const videos = useMemo(() => (files.data ?? []).filter((f) => f.kind === 'video'), [files.data]);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);

  // Resume target: the first unfinished lesson that has a saved position,
  // otherwise the first lesson.
  const resumeTarget = useMemo(
    () => videos.find((v) => !v.completed && (v.position_seconds ?? 0) > 0) ?? videos[0] ?? null,
    [videos],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the player only when the course changes
  useEffect(() => {
    setPlayingId(null);
    setSeekTo(null);
  }, [assetId]);

  const active = videos.find((v) => v.id === playingId) ?? null;
  const courseHits = (hits.data ?? []).filter((h) => h.asset_id === assetId);

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-surface-800/60 px-5">
        <span className="min-w-0 truncate font-display cap-15 font-semibold text-surface-50">
          {course.data?.display_title ?? course.data?.name ?? '…'}
        </span>
        <span className="ml-auto shrink-0 font-mono cap-11 text-surface-400">
          {formatDuration(course.data?.duration_seconds)} ·{' '}
          {formatCount(course.data?.video_count ?? 0)} videos
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-5 p-5">
        {active ? (
          <Player
            key={active.id}
            fileId={active.id}
            absPath={active.abs_path}
            title={active.rel_path.split('/').pop() ?? active.rel_path}
            startAt={seekTo ?? active.position_seconds ?? 0}
            onEnded={() => setPlayingId(null)}
          />
        ) : resumeTarget ? (
          <button
            type="button"
            onClick={() => setPlayingId(resumeTarget.id)}
            className="flex items-center gap-3 rounded-md border border-surface-800 bg-surface-900 px-4 py-3 text-left transition-colors hover:border-accent-500/50"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-500 text-accent-on">
              <Play size={16} />
            </span>
            <span className="min-w-0">
              <span className="block truncate cap-14 text-surface-50">
                {(resumeTarget.position_seconds ?? 0) > 0 ? 'Resume' : 'Start'} —{' '}
                {resumeTarget.rel_path.split('/').pop()}
              </span>
              {(resumeTarget.position_seconds ?? 0) > 0 ? (
                <span className="block font-mono cap-11 text-surface-400">
                  at {formatClock(resumeTarget.position_seconds ?? 0)}
                </span>
              ) : null}
            </span>
          </button>
        ) : null}

        {courseHits.length > 0 ? (
          <div className="flex flex-col gap-2 border-accent-500/50 border-l-2 pl-3">
            <span className="font-mono cap-10 uppercase tracking-[0.16em] text-surface-400">
              Transcript hits for “{transcriptQuery}”
            </span>
            {courseHits.slice(0, 8).map((h) => {
              // A cue belongs to a subtitle file; the lesson is the video with
              // the same stem beside it. The shared stem helpers handle the
              // `lesson.mp4.srt` shape the Whisper backfill writes — stripping
              // a single extension from both sides never pairs those.
              const target = videos.find((v) => videoStem(v.rel_path) === subtitleStem(h.rel_path));
              return (
                <button
                  key={`${h.file_id}-${h.start_ms}`}
                  type="button"
                  disabled={!target}
                  onClick={() => {
                    if (!target) return;
                    setPlayingId(target.id);
                    setSeekTo(h.start_ms / 1000);
                  }}
                  className="text-left cap-12 text-surface-200 disabled:opacity-60"
                >
                  <span className="font-mono text-accent-400">
                    {formatClock(h.start_ms / 1000)}
                  </span>{' '}
                  {h.text}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Keyed so switching courses unmounts the pane: its unmount cleanup
            cancels any in-flight answer, and no state can leak across courses. */}
        <AskPane
          key={assetId}
          assetId={assetId}
          onSeek={(videoId, seconds) => {
            setPlayingId(videoId);
            setSeekTo(seconds);
          }}
        />

        <ChapterList
          files={files.data ?? []}
          activeId={playingId}
          onPlay={(id) => {
            setPlayingId(id);
            setSeekTo(null);
          }}
        />
      </div>
    </section>
  );
}

interface FileRow {
  readonly id: number;
  readonly rel_path: string;
  readonly kind: string;
  readonly chapter: string | null;
  readonly duration_seconds: number | null;
  readonly position_seconds: number | null;
  readonly completed: number;
  readonly has_subtitle: number;
}

function ChapterList({
  files,
  activeId,
  onPlay,
}: {
  readonly files: ReadonlyArray<FileRow>;
  readonly activeId: number | null;
  readonly onPlay: (id: number) => void;
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, FileRow[]>();
    for (const f of files) {
      if (f.kind !== 'video') continue;
      const key = f.chapter ?? '';
      map.set(key, [...(map.get(key) ?? []), f]);
    }
    return [...map.entries()];
  }, [files]);

  if (grouped.length === 0) {
    return (
      <p className="cap-12 text-surface-400">
        No videos indexed for this course. Run a scan to build its manifest.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {grouped.map(([chapter, items]) => (
        <div key={chapter || '__root'} className="flex flex-col">
          {chapter ? (
            <span className="pb-1 font-mono cap-10 uppercase tracking-[0.16em] text-surface-500">
              {chapter}
            </span>
          ) : null}
          {items.map((f) => (
            <button
              key={f.id}
              type="button"
              data-testid="course-lesson"
              onClick={() => onPlay(f.id)}
              className={cn(
                'flex items-center gap-3 border-b border-surface-800/40 py-2 text-left transition-colors',
                f.id === activeId ? 'text-accent-300' : 'text-surface-200 hover:text-surface-50',
              )}
            >
              {f.completed ? (
                <Check size={13} className="shrink-0 text-success-500" />
              ) : (
                <Play size={12} className="shrink-0 text-surface-500" />
              )}
              <span className="min-w-0 flex-1 truncate cap-14">{f.rel_path.split('/').pop()}</span>
              {f.has_subtitle ? <Captions size={12} className="shrink-0 text-surface-500" /> : null}
              <span className="shrink-0 font-mono tabular-nums cap-11 text-surface-400">
                {formatDuration(f.duration_seconds)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Throttle for position writes — one row per lesson, but not 4x a second. */
const SAVE_EVERY_MS = 5000;
/** Past this fraction the lesson counts as watched. */
const COMPLETE_AT = 0.95;

function Player({
  fileId,
  absPath,
  title,
  startAt,
  onEnded,
}: {
  readonly fileId: number;
  readonly absPath: string;
  readonly title: string;
  readonly startAt: number;
  readonly onEnded: () => void;
}) {
  const utils = trpc.useUtils();
  const ref = useRef<HTMLVideoElement | null>(null);
  const lastSave = useRef(0);
  const setProgress = trpc.courses.setProgress.useMutation();

  // Captions. `<track src>` must be WebVTT, and most of the library ships .srt,
  // so main converts and hands back text; a blob URL turns that into something
  // the element can load. Revoked on change so switching lessons for an hour
  // does not leak a blob per lesson.
  // Some containers the scanner indexes cannot be decoded by Chromium at all.
  // Driven by the element's own error event rather than an extension blocklist:
  // that is ground truth per file, and a guess would eventually refuse a file
  // that plays fine. Measured examples — an .mp4 lesson plays through this exact
  // protocol, while a real MPEG-TS fails with DEMUXER_ERROR_COULD_NOT_OPEN and
  // canPlayType('video/mp2t') is ''.
  const [failed, setFailed] = useState(false);
  // Reset during render rather than in an effect: React's documented way to
  // adjust state when a prop changes, and it clears the flag before the new
  // lesson paints instead of one frame after it.
  const [lastFileId, setLastFileId] = useState(fileId);
  if (fileId !== lastFileId) {
    setLastFileId(fileId);
    setFailed(false);
  }

  const subtitle = trpc.courses.subtitleTrack.useQuery(fileId);
  const vtt = subtitle.data ?? null;
  const [trackUrl, setTrackUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!vtt) {
      setTrackUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    setTrackUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [vtt]);

  // Seek once metadata is in — currentTime assignments before that are
  // discarded by the element.
  const onLoadedMetadata = useCallback(() => {
    if (ref.current && startAt > 0) ref.current.currentTime = startAt;
  }, [startAt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: persist once on unmount, not on every mutation identity change
  useEffect(() => {
    const el = ref.current;
    // Closing the panel mid-lesson is the common case, and the throttle alone
    // would drop up to five seconds of it.
    return () => {
      if (el && el.currentTime > 0) {
        setProgress.mutate({
          fileId,
          positionSeconds: el.currentTime,
          completed: el.duration > 0 && el.currentTime / el.duration > COMPLETE_AT,
        });
      }
    };
  }, [fileId]);

  if (failed) {
    const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toUpperCase();
    return (
      <div className="flex flex-col gap-2">
        <div
          data-testid="course-player-unsupported"
          className="flex w-full flex-col items-center justify-center gap-3 rounded-md border border-surface-800 bg-surface-925 px-6 py-10 text-center"
          style={{ minHeight: '32vh' }}
        >
          <CircleSlash size={22} className="text-warning-300" />
          <p className="cap-14 text-surface-200">
            This lesson is a {ext} file the player cannot decode.
          </p>
          {/* The lesson is still fully indexed — chapter order, duration and
              transcript search all work. Only in-app playback does not, so the
              honest move is to hand it to something that can play it rather
              than show a black rectangle. */}
          <p className="cap-12 text-surface-400">
            It is still indexed and searchable. Open it in your default player to watch.
          </p>
          <button
            type="button"
            onClick={() => void window.omnidex?.shell?.openPath(absPath)}
            className="mt-1 rounded-sm border border-surface-700 bg-surface-900 px-3 py-1.5 cap-12 text-surface-100 transition-colors hover:border-surface-600 hover:bg-surface-800"
          >
            Open in default player
          </button>
        </div>
        <span className="truncate font-mono cap-11 text-surface-400">{title}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* biome-ignore lint/a11y/useMediaCaption: a track is mounted below whenever
          the lesson HAS a sidecar; the rule cannot see a conditional child, and
          the many lessons that ship no subtitles cannot be given one here. */}
      <video
        ref={ref}
        data-testid="course-player"
        src={toAssetUrl(absPath) ?? ''}
        controls
        className="w-full rounded-md bg-black"
        style={{ maxHeight: '52vh' }}
        onLoadedMetadata={onLoadedMetadata}
        onError={() => setFailed(true)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          const now = Date.now();
          if (now - lastSave.current < SAVE_EVERY_MS) return;
          lastSave.current = now;
          setProgress.mutate({
            fileId,
            positionSeconds: el.currentTime,
            completed: el.duration > 0 && el.currentTime / el.duration > COMPLETE_AT,
          });
        }}
        onEnded={() => {
          setProgress.mutate(
            { fileId, positionSeconds: ref.current?.duration ?? 0, completed: true },
            { onSuccess: () => void utils.courses.invalidate() },
          );
          onEnded();
        }}
      >
        {trackUrl ? (
          <track
            // `default` so captions are on when they exist. The player is for
            // studying a 2,000-hour library of technical instruction, where the
            // exact spelling of AbilitySystemComponent is the point — that is
            // worth showing by default rather than hiding behind a menu.
            default
            kind="captions"
            label="Subtitles"
            src={trackUrl}
          />
        ) : null}
      </video>
      <span className="truncate font-mono cap-11 text-surface-400">{title}</span>
    </div>
  );
}
