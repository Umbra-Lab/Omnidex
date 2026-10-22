import { useRef, useState } from 'react';
import { trpc } from '@/ipc/trpc';

/**
 * Accumulates the `ask.onStream` events belonging to one request id.
 *
 * Events are buffered per request id regardless of which id the caller is
 * currently watching. That closes a real race: a dead local server rejects in
 * ~1ms, so the error event can arrive before React has committed the state
 * that tells this hook its request id — filtering against "the active id" at
 * arrival time would drop it and leave the pane busy forever. Buffered, the
 * caller finds the already-complete state the moment it learns its id.
 */

export interface AskUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface AskContextInfo {
  mode: 'full' | 'scoped';
  lessonCount: number;
  includedCount: number;
  tokenEstimate: number;
  lessons: ReadonlyArray<{
    lessonId: number;
    videoFileId: number | null;
    title: string;
    chapter: string | null;
  }>;
}

export interface AskStreamState {
  text: string;
  done: boolean;
  error: string | null;
  usage: AskUsage | null;
  context: AskContextInfo | null;
}

const IDLE: AskStreamState = { text: '', done: false, error: null, usage: null, context: null };

/** Streams older than this many ids behind the newest are dropped. */
const KEEP_BEHIND = 8;

export function useAskStream(requestId: number | null): AskStreamState {
  const streams = useRef(new Map<number, AskStreamState>());
  const [, bump] = useState(0);

  trpc.ask.onStream.useSubscription(undefined, {
    onData(event) {
      const prev = streams.current.get(event.requestId) ?? IDLE;
      let next = prev;
      if (event.type === 'delta') {
        next = { ...prev, text: prev.text + (event.text ?? '') };
      } else if (event.type === 'context') {
        next = { ...prev, context: event.context ?? null };
      } else if (event.type === 'done') {
        // The done event's text is authoritative — a dropped delta must not
        // leave the saved answer short.
        next = { ...prev, text: event.text ?? prev.text, usage: event.usage ?? null, done: true };
      } else if (event.type === 'error') {
        next = { ...prev, error: event.message ?? 'Something went wrong.', done: true };
      }
      streams.current.set(event.requestId, next);
      for (const id of streams.current.keys()) {
        if (id < event.requestId - KEEP_BEHIND) streams.current.delete(id);
      }
      bump((n) => n + 1);
    },
  });

  return requestId === null ? IDLE : (streams.current.get(requestId) ?? IDLE);
}
