// Types for search.mjs, so the vitest suite in electron/ can import it under strict tsc.
export const FEW: number;
export function queryTerms(query: unknown): string[];
export function andQuery(terms: string[], prefix: boolean): string;
export function orQuery(terms: string[], prefix: boolean): string;
export function isStopword(term: string): boolean;
export function contentTerms(terms: string[], noise?: Set<string>): string[];
export function editDistance(a: string, b: string): number;
export function nearestTerm(word: string, vocab: { term: string; doc: number }[]): string | null;
export function stemPrefix(word: string, vocab: { term: string; doc: number }[]): string | null;

export interface StagedResult<Row> {
  rows: Row[];
  notes: string[];
  empty?: boolean;
}

interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

export function createSearch(
  db: SqlDb,
  options?: { legacy?: boolean },
): {
  transcripts(
    query: string,
    limit: number,
    likeCourse?: string,
  ): StagedResult<Record<string, unknown>>;
  assets(query: string, limit: number): StagedResult<Record<string, unknown>>;
};
