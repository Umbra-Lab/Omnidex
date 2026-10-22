export interface OrbitalProduct {
  _id: string;
  title: string;
  price: number;
  discount: number;
  media: {
    thumbnail: string;
  };
  review: {
    count: number;
    rating: number;
  };
  computed: {
    score: number;
  };
  meta: {
    fabId: string;
  };
  owner: {
    name: string;
  };
  engine: {
    min: string;
    max: string;
  };
}

export interface OrbitalSearchOptions {
  categories?: string[];
  limit?: number;
  engineMin?: string;
  engineMax?: string;
}

export interface OrbitalApiState {
  cache: Map<string, OrbitalProduct>;
  loading: Map<number, boolean>;
  errors: Map<number, string | null>;
}

// Batch Matching Types
export type ConfidenceLevel = 'AutoAccept' | 'NeedsReview' | 'NoMatch';

export interface BulkMatchResult {
  folder_name: string;
  matched_product_slug: string | null;
  matched_product_title: string | null;
  confidence: number;
  confidence_level: ConfidenceLevel;
  matched_from_manifest: boolean;
  asset_id: number | null;
}

export interface BulkMatchSummary {
  auto_accept: BulkMatchResult[];
  needs_review: BulkMatchResult[];
  no_match: BulkMatchResult[];
  total_processed: number;
}

export type BulkMatchPhase = 'manifest' | 'api_search' | 'complete';

export interface BulkMatchProgressEvent {
  phase: BulkMatchPhase;
  current: number;
  total: number;
  message: string;
}

// Match Report Types (Phase 09 - Orbital Market Features)
export interface MatchReportEntry {
  asset_id: number;
  asset_name: string;
  scan_location_name: string;
  match_status: 'matched' | 'unmatched';
  matched_product: string | null;
  confidence: number | null;
  match_method: string | null;
  orbital_url: string | null;
}

export interface MatchReport {
  entries: MatchReportEntry[];
  matched_count: number;
  unmatched_count: number;
  avg_confidence: number;
}
