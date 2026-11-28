import type { CountPhrase } from './removalSummary';

/** A counted phrase from a removal summary, with only the number in mono. */
export function Counted({ phrase }: { readonly phrase: CountPhrase }) {
  return (
    <span className="text-surface-100">
      {phrase.before}
      <span className="font-mono tabular-nums">{phrase.count}</span> {phrase.label}
    </span>
  );
}
