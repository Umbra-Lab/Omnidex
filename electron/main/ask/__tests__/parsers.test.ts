import { describe, expect, it } from 'vitest';
import { parseClaudeLine, parseOpenAiEvent, splitSseEvents } from '../parsers';

describe('splitSseEvents', () => {
  it('keeps an unterminated event in the rest buffer', () => {
    const { events, rest } = splitSseEvents('data: {"a":1}\n\ndata: {"b"');
    expect(events).toEqual(['data: {"a":1}']);
    expect(rest).toBe('data: {"b"');
  });

  it('handles CRLF and multiple complete events', () => {
    const { events, rest } = splitSseEvents('data: 1\r\n\r\ndata: 2\r\n\r\n');
    expect(events).toEqual(['data: 1', 'data: 2']);
    expect(rest).toBe('');
  });
});

describe('parseOpenAiEvent', () => {
  it('extracts a content delta', () => {
    const out = parseOpenAiEvent('data: {"choices":[{"delta":{"content":"Hel"}}]}');
    expect(out.delta).toBe('Hel');
    expect(out.done).toBe(false);
  });

  it('flags [DONE]', () => {
    expect(parseOpenAiEvent('data: [DONE]').done).toBe(true);
  });

  it('reads usage when the server sends it', () => {
    const out = parseOpenAiEvent(
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}',
    );
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 45, costUsd: null });
  });

  it('survives malformed JSON', () => {
    expect(parseOpenAiEvent('data: {nope').delta).toBeNull();
  });
});

describe('parseClaudeLine', () => {
  it('captures the session id from init', () => {
    const out = parseClaudeLine(
      '{"type":"system","subtype":"init","session_id":"abc-123","tools":[]}',
    );
    expect(out.sessionId).toBe('abc-123');
  });

  it('extracts text deltas from stream events', () => {
    const out = parseClaudeLine(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"chunk"}}}',
    );
    expect(out.delta).toBe('chunk');
  });

  it('joins text blocks of a buffered assistant message', () => {
    const out = parseClaudeLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}',
    );
    expect(out.assistantText).toBe('ab');
  });

  it('parses a success result with usage and cost', () => {
    const out = parseClaudeLine(
      '{"type":"result","subtype":"success","result":"Answer.","session_id":"s1","usage":{"input_tokens":9,"output_tokens":4},"total_cost_usd":0.012}',
    );
    expect(out.result?.text).toBe('Answer.');
    expect(out.result?.usage).toEqual({ inputTokens: 9, outputTokens: 4, costUsd: 0.012 });
    expect(out.sessionId).toBe('s1');
  });

  it('surfaces error results as errors', () => {
    const out = parseClaudeLine('{"type":"result","subtype":"error_max_turns"}');
    expect(out.error).toContain('error_max_turns');
  });

  it('ignores unknown shapes and non-JSON lines', () => {
    expect(parseClaudeLine('not json').delta).toBeNull();
    expect(parseClaudeLine('{"type":"user"}').delta).toBeNull();
  });
});
