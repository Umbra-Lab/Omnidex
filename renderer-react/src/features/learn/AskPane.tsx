import { CircleStop, CornerDownLeft, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type AskContextInfo, useAskStream } from '@/hooks/useAskStream';
import { trpc } from '@/ipc/trpc';
import { splitAnswer } from '@/lib/citations';
import { cn } from '@/lib/cn';

/**
 * Ask this course — a question box under the player that answers from the
 * course transcript and cites its way back into the video.
 *
 * Answers stream over `ask.onStream`; inline `[[lesson_id@seconds]]` markers
 * render as seek chips that drive the same player state the transcript-hit
 * buttons use. Provider and context provenance stay visible: which model
 * answered, and whether it saw the whole course or a question-scoped subset.
 */

interface ThreadMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

const FAILURE_TEXT: Record<string, string> = {
  'no-course': 'This course is no longer in the library.',
  'claude-code-missing':
    'Claude Code is not installed on this machine. Switch the Ask provider to Local in Settings → AI.',
};

/** The server validates history at 20 entries / 20k chars each; stay under both. */
const HISTORY_LIMIT = 12;
const HISTORY_CHAR_LIMIT = 20_000;

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function AskPane({
  assetId,
  onSeek,
}: {
  readonly assetId: number;
  readonly onSeek: (videoFileId: number, seconds: number) => void;
}) {
  const status = trpc.ask.status.useQuery();
  const [thread, setThread] = useState<ThreadMessage[]>([]);
  const [input, setInput] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const [contextInfo, setContextInfo] = useState<AskContextInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUsage, setLastUsage] = useState<{
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
  } | null>(null);

  const stream = useAskStream(activeId);

  // Citations must keep working across context changes: a scoped follow-up
  // includes a different lesson subset, and replacing the map would kill the
  // chips in earlier answers. Accumulate instead.
  const lessonsById = useRef(new Map<number, { videoFileId: number | null; title: string }>());
  useEffect(() => {
    if (!stream.context) return;
    for (const l of stream.context.lessons) {
      lessonsById.current.set(l.lessonId, { videoFileId: l.videoFileId, title: l.title });
    }
    setContextInfo(stream.context);
  }, [stream.context]);

  useEffect(() => {
    if (activeId === null || !stream.done) return;
    if (stream.error) {
      setError(stream.error);
    } else if (stream.text) {
      setThread((t) => [...t, { role: 'assistant', content: stream.text }]);
      setLastUsage(stream.usage);
    } else {
      // A completed request with no text and no error is still an outcome the
      // user must see, or the question just silently vanishes.
      setError('The provider returned an empty answer.');
    }
    setActiveId(null);
  }, [activeId, stream.done, stream.error, stream.text, stream.usage]);

  const start = trpc.ask.start.useMutation({
    onSuccess(result) {
      if (!result.ok) {
        setError(FAILURE_TEXT[result.reason] ?? `Ask failed: ${result.reason}`);
        return;
      }
      setActiveId(result.requestId);
    },
    onError(e) {
      setError(e.message);
    },
  });
  const cancel = trpc.ask.cancel.useMutation();

  // Leaving the course (this pane is keyed by assetId) or the Learn view
  // mid-answer must stop the generation — on a one-slot llama server an
  // orphaned request blocks the next question until it finishes.
  const activeRef = useRef<number | null>(null);
  activeRef.current = activeId;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(
    () => () => {
      if (activeRef.current !== null) {
        cancelRef.current.mutate({ requestId: activeRef.current });
      }
    },
    [],
  );

  const busy = activeId !== null;
  const endRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the stream as it grows
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [stream.text, thread.length]);

  const send = () => {
    const question = input.trim();
    if (!question || busy) return;
    setError(null);
    setThread((t) => [...t, { role: 'user', content: question }]);
    setInput('');
    start.mutate({
      assetId,
      question,
      // Trimmed to the server's validation caps — an over-long thread must
      // degrade to a shorter memory, not brick every further question.
      history: thread
        .slice(-HISTORY_LIMIT)
        .map(({ role, content }) => ({ role, content: content.slice(0, HISTORY_CHAR_LIMIT) })),
    });
  };

  const renderAnswer = (text: string) => {
    const parts = splitAnswer(text);
    return (
      <span className="whitespace-pre-wrap">
        {parts.map((part, i) =>
          part.kind === 'text' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
            <span key={i}>{part.text}</span>
          ) : (
            <CitationChip
              // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
              key={i}
              lessonId={part.lessonId}
              seconds={part.seconds}
              lessonsById={lessonsById.current}
              onSeek={onSeek}
            />
          ),
        )}
      </span>
    );
  };

  const providerBadge =
    status.data == null
      ? '…'
      : status.data.provider === 'local'
        ? `Local · ${status.data.localModel}`
        : 'Claude Code';

  return (
    <div className="flex flex-col gap-3 rounded-md border border-surface-800 bg-surface-925 p-4">
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-accent-400" />
        <span className="cap-13 font-medium text-surface-50">Ask this course</span>
        <span className="ml-auto font-mono cap-10 text-surface-400">{providerBadge}</span>
      </div>

      {thread.length === 0 && !busy ? (
        <p className="cap-12 text-surface-400">
          Answers come from this course's transcript, with citations that jump the player to the
          moment.
        </p>
      ) : null}

      {thread.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only thread
        <div key={i} className={cn('cap-13', m.role === 'user' ? 'text-surface-300' : 'text-surface-100')}>
          {m.role === 'user' ? (
            <span className="font-medium text-surface-200">You: {m.content}</span>
          ) : (
            renderAnswer(m.content)
          )}
        </div>
      ))}

      {busy ? (
        <div className="cap-13 text-surface-100">
          {stream.text ? (
            renderAnswer(stream.text)
          ) : (
            <span className="cap-12 text-surface-400">Thinking…</span>
          )}
          <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent-400 align-text-bottom" />
        </div>
      ) : null}
      <div ref={endRef} />

      {error ? <p className="cap-12 text-danger-400">{error}</p> : null}

      {contextInfo ? (
        <p className="font-mono cap-10 text-surface-500">
          Context:{' '}
          {contextInfo.mode === 'full'
            ? `whole course (~${Math.round(contextInfo.tokenEstimate / 1000)}k tokens)`
            : `${contextInfo.includedCount} of ${contextInfo.lessonCount} lessons (~${Math.round(contextInfo.tokenEstimate / 1000)}k tokens)`}
          {lastUsage?.outputTokens != null ? ` · ${lastUsage.outputTokens} tokens out` : ''}
          {lastUsage?.costUsd != null && lastUsage.costUsd > 0
            ? ` · $${lastUsage.costUsd.toFixed(3)}`
            : ''}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="How does the instructor set up…?"
          aria-label="Ask this course"
          disabled={busy}
          className="h-8 min-w-0 flex-1 rounded-sm border border-surface-800 bg-surface-900 px-2.5 cap-12 text-surface-100 outline-none placeholder:text-surface-500 focus:border-accent-500/60 disabled:opacity-60"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => {
              if (activeId !== null) cancel.mutate({ requestId: activeId });
            }}
            className="flex h-8 items-center gap-1.5 rounded-sm border border-surface-700 px-2.5 cap-12 text-surface-200 transition-colors hover:border-surface-600"
          >
            <CircleStop size={13} /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={input.trim().length === 0}
            className="flex h-8 items-center gap-1.5 rounded-sm bg-accent-500 px-2.5 cap-12 text-accent-on transition-opacity disabled:opacity-40"
          >
            <CornerDownLeft size={13} /> Ask
          </button>
        )}
      </div>
    </div>
  );
}

function CitationChip({
  lessonId,
  seconds,
  lessonsById,
  onSeek,
}: {
  readonly lessonId: number;
  readonly seconds: number;
  readonly lessonsById: ReadonlyMap<number, { videoFileId: number | null; title: string }>;
  readonly onSeek: (videoFileId: number, seconds: number) => void;
}) {
  const lesson = lessonsById.get(lessonId);
  const target = lesson?.videoFileId ?? null;
  return (
    <button
      type="button"
      disabled={target === null}
      title={lesson ? `${lesson.title} at ${formatClock(seconds)}` : 'Unknown lesson'}
      onClick={() => {
        if (target !== null) onSeek(target, seconds);
      }}
      className={cn(
        'mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full border px-1.5 py-px font-mono cap-10',
        target !== null
          ? 'border-accent-500/50 text-accent-300 transition-colors hover:bg-accent-500/10'
          : 'border-surface-700 text-surface-500',
      )}
    >
      ▶ {formatClock(seconds)}
    </button>
  );
}
