import type { AskUsage } from './bus';

/**
 * Pure stream-parsing for the two Ask providers, kept free of fetch/spawn so
 * the byte-level edge cases (split chunks, partial lines, malformed events)
 * are unit-testable without a live server or CLI.
 */

/** Split an SSE buffer into complete events; the unterminated tail carries over. */
export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { events: parts.filter((p) => p.trim().length > 0), rest };
}

export interface OpenAiChunk {
  delta: string | null;
  usage: AskUsage | null;
  done: boolean;
}

/** Parse one OpenAI-compatible SSE event (llama.cpp / llama-swap speak this). */
export function parseOpenAiEvent(event: string): OpenAiChunk {
  const data = event
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  if (!data) return { delta: null, usage: null, done: false };
  if (data === '[DONE]') return { delta: null, usage: null, done: true };

  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { delta: null, usage: null, done: false };
  }
  const obj = json as {
    choices?: { delta?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  };
  const delta = obj.choices?.[0]?.delta?.content ?? null;
  const usage = obj.usage
    ? {
        inputTokens: obj.usage.prompt_tokens ?? null,
        outputTokens: obj.usage.completion_tokens ?? null,
        costUsd: null,
      }
    : null;
  return { delta, usage, done: false };
}

export interface ClaudeLineOut {
  sessionId: string | null;
  delta: string | null;
  /** Full text of a buffered assistant message (fallback when no deltas came). */
  assistantText: string | null;
  /** Set on the terminal result line. */
  result: { text: string; usage: AskUsage | null } | null;
  error: string | null;
}

const EMPTY: ClaudeLineOut = {
  sessionId: null,
  delta: null,
  assistantText: null,
  result: null,
  error: null,
};

/**
 * Parse one line of `claude -p --output-format stream-json` output.
 *
 * Shapes handled: `system/init` (session id for `--resume`), `stream_event`
 * text deltas (present with `--include-partial-messages`), buffered
 * `assistant` messages, and the terminal `result` line carrying usage and
 * cost. Unknown line shapes parse to the empty result rather than throwing —
 * the CLI adds event types over time.
 */
export function parseClaudeLine(line: string): ClaudeLineOut {
  const trimmed = line.trim();
  if (!trimmed) return EMPTY;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return EMPTY;
  }
  const obj = json as Record<string, unknown>;

  if (obj.type === 'system' && obj.subtype === 'init') {
    return { ...EMPTY, sessionId: typeof obj.session_id === 'string' ? obj.session_id : null };
  }

  if (obj.type === 'stream_event') {
    const event = obj.event as
      | { type?: string; delta?: { type?: string; text?: string } }
      | undefined;
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      return { ...EMPTY, delta: event.delta.text ?? '' };
    }
    return EMPTY;
  }

  if (obj.type === 'assistant') {
    const message = obj.message as { content?: { type?: string; text?: string }[] } | undefined;
    const text = (message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return text ? { ...EMPTY, assistantText: text } : EMPTY;
  }

  if (obj.type === 'result') {
    const sessionId = typeof obj.session_id === 'string' ? obj.session_id : null;
    if (obj.subtype && obj.subtype !== 'success') {
      const detail = typeof obj.result === 'string' ? `: ${obj.result}` : '';
      return { ...EMPTY, sessionId, error: `Claude Code ${String(obj.subtype)}${detail}` };
    }
    const usageObj = obj.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    const usage: AskUsage = {
      inputTokens: usageObj?.input_tokens ?? null,
      outputTokens: usageObj?.output_tokens ?? null,
      costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null,
    };
    return {
      ...EMPTY,
      sessionId,
      result: { text: typeof obj.result === 'string' ? obj.result : '', usage },
    };
  }

  return EMPTY;
}
