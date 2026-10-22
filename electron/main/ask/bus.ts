import { EventEmitter } from 'node:events';

/**
 * Stream bus for Ask answers, mirroring `progress/bus.ts`: providers publish
 * JSON-safe events here, the `ask.onStream` tRPC subscription forwards them to
 * the renderer. Payloads stay plain numbers/strings/null so the high-frequency
 * delta stream crosses the superjson boundary cheaply.
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
  lessons: {
    lessonId: number;
    videoFileId: number | null;
    title: string;
    chapter: string | null;
  }[];
}

export interface AskStreamEvent {
  requestId: number;
  type: 'context' | 'delta' | 'done' | 'error';
  /** Incremental answer text on 'delta'; the full final text on 'done'. */
  text?: string;
  usage?: AskUsage | null;
  /** Human-readable failure on 'error'. */
  message?: string;
  /** What went into the prompt, on 'context'. */
  context?: AskContextInfo;
}

type Events = {
  ask: [AskStreamEvent];
};

class AskBus extends EventEmitter<Events> {}

export const askBus = new AskBus();
askBus.setMaxListeners(20);

export function emitAsk(e: AskStreamEvent): void {
  askBus.emit('ask', e);
}
