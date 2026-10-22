/**
 * Scan diagnostics — what the scanner could NOT index, and why.
 *
 * The walker already computes every fact below and used to throw it away, so
 * a folder that produced no card was indistinguishable from a folder that
 * doesn't exist. These rows are what the Library Health view reads.
 */
export type ScanDiagnosticKind =
  /** Folder holds only archives (.rar/.zip/.7z/…) — nothing to index until extracted. */
  | 'archive-only'
  /** Pack-finder hit `MAX_PACK_SEARCH_DEPTH` and gave up before reaching content. */
  | 'depth-limit-abandoned'
  /** Pack has `.uasset` files but thumbnail extraction produced nothing. */
  | 'thumbnail-failed'
  /** Pack contains paths close enough to Windows' 260-char `MAX_PATH` to break tools. */
  | 'path-near-max-length';

/** A diagnostic as emitted by the scanner, before it gets an id/timestamp. */
export interface ScanDiagnostic {
  kind: ScanDiagnosticKind;
  /** Absolute path the diagnostic is about. */
  path: string;
  /** Human-readable cause, shown verbatim in the drill-down list. */
  detail: string;
}

/** A persisted diagnostic row. */
export interface ScanDiagnosticRow extends ScanDiagnostic {
  id: number;
  scan_location_id: number;
  created_at: string;
}

export interface ScanDiagnosticSummary {
  kind: ScanDiagnosticKind;
  count: number;
}
