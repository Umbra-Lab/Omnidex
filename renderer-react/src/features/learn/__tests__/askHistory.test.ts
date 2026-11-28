import { describe, expect, it } from 'vitest';
import { askHistory, HISTORY_CHAR_LIMIT, HISTORY_LIMIT } from '../askHistory';

const u = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

describe('askHistory', () => {
  it('keeps answered questions with their answers', () => {
    expect(askHistory([u('q1'), a('a1'), u('q2'), a('a2')])).toEqual([
      u('q1'),
      a('a1'),
      u('q2'),
      a('a2'),
    ]);
  });

  it('drops a question that never got an answer, so roles keep alternating', () => {
    expect(askHistory([u('q1'), a('a1'), u('failed'), u('q3'), a('a3')])).toEqual([
      u('q1'),
      a('a1'),
      u('q3'),
      a('a3'),
    ]);
    expect(askHistory([u('failed')])).toEqual([]);
  });

  it('trims to whole pairs, starting with a question', () => {
    const thread = Array.from({ length: 10 }, (_, i) => [u(`q${i}`), a(`a${i}`)]).flat();
    const history = askHistory(thread);
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toEqual(u('q4'));
    expect(history.at(-1)).toEqual(a('a9'));
  });

  it('caps each message at the server limit', () => {
    const long = 'x'.repeat(HISTORY_CHAR_LIMIT + 50);
    const [q, ans] = askHistory([u(long), a(long)]);
    expect(q.content).toHaveLength(HISTORY_CHAR_LIMIT);
    expect(ans.content).toHaveLength(HISTORY_CHAR_LIMIT);
  });
});
