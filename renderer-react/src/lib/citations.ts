/**
 * Inline citation markers in Ask answers.
 *
 * The model is instructed to cite as `[[lesson_id@seconds]]`; the renderer
 * splits answer text around those markers and turns each into a seek chip.
 * Anything that does not match the exact shape stays visible as plain text —
 * a mangled citation should be readable, not silently swallowed.
 */

export type AnswerPart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'cite'; readonly lessonId: number; readonly seconds: number };

const MARKER = /\[\[(\d+)@(\d+(?:\.\d+)?)\]\]/g;

export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: 'text', text: text.slice(last, index) });
    parts.push({
      kind: 'cite',
      lessonId: Number(match[1]),
      seconds: Number(match[2]),
    });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
