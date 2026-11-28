/** The server validates history at 20 entries / 20k chars each; stay under both. */
export const HISTORY_LIMIT = 12;
export const HISTORY_CHAR_LIMIT = 20_000;

export interface HistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * The history sent with the next question: only questions that got an answer,
 * each followed by that answer.
 *
 * A question that failed, came back empty or was stopped before any text stays
 * on screen but has no answer. Sending it would put two user turns in a row,
 * and many local chat templates (Gemma, Mistral and others) reject that with
 * "roles must alternate", which then fails every later question too. Keeping
 * whole pairs also means the trimmed window always starts with a question.
 */
export function askHistory(thread: readonly HistoryMessage[]): HistoryMessage[] {
  const pairs: HistoryMessage[] = [];
  for (let i = 0; i + 1 < thread.length; i++) {
    const q = thread[i];
    const a = thread[i + 1];
    if (q.role === 'user' && a.role === 'assistant') {
      pairs.push(
        { role: 'user', content: q.content.slice(0, HISTORY_CHAR_LIMIT) },
        { role: 'assistant', content: a.content.slice(0, HISTORY_CHAR_LIMIT) },
      );
      i++;
    }
  }
  return pairs.slice(-HISTORY_LIMIT);
}
