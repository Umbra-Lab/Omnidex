import Fuse from 'fuse.js';
import type { OrbitalSearchItem } from './models';
import { searchProducts } from './search';

/**
 * Fuzzy matcher over Orbital Market search results.
 *
 * Mirrors the intent of `src-tauri/src/orbital/unified_matcher.rs` without
 * reimplementing its jaro-winkler-specific weighting.
 *
 * This file used to claim Fuse.js's Bitap scoring "behaves comparably" to
 * jaro-winkler on pack names. It does not, and that assumption is what the
 * confidence bands below were calibrated against: Bitap is word-width limited,
 * so it under-scores long patterns badly enough that an EXACT match on a
 * 46-character name scored 0.532 and was reported as `low`. Pack names are
 * long, so scoring now takes `max(fuse, tokenSimilarity)` — see
 * `tokenSimilarity` for the measurements and the false-positive guard.
 *
 * We use the same normalization pass as the Rust `AssetMatcher::clean_name`:
 *   - strip parentheses / brackets contents
 *   - strip v1.2 / UE5 / 4.27 version tokens
 *   - lowercase, collapse separators to spaces
 *
 * Version stripping is deliberately narrow: only tokens that carry a *version
 * signal* are removed — a `v`/`V` prefix (`v8`, `v1.2`), a dotted/underscored
 * sub-version (`4.27`, `1.2.3`), or a known-engine prefix (`UE5`, `UE5.3`).
 * A standalone bare integer (`100` in "Top 100 Materials", `40000` in
 * "Warhammer 40000", `76` in "Fallout 76") is a meaningful part of the name,
 * not a version, so it is preserved — stripping it degrades or empties real
 * queries. The earlier `/\b[vV]?\d+([._]\d+)*\b/` ate every bare integer.
 *
 * Confidence bands (parity with Rust `MatchStrength`):
 *   exact   ≥ 0.90
 *   high    ≥ 0.75
 *   medium  ≥ 0.55
 *   low     ≥ 0.35
 *   none    <  0.35
 */

export type MatchStrength = 'exact' | 'high' | 'medium' | 'low' | 'none';

export interface MatchResult {
  item: OrbitalSearchItem;
  score: number;
  strength: MatchStrength;
}

const EXACT_THRESHOLD = 0.9;
const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.55;
const LOW_THRESHOLD = 0.35;

/**
 * Strips version tokens only — NOT standalone numbers. A token is a version if:
 *   - it has a `v`/`V` prefix:            v8, v1.2, V2
 *   - it has a dotted sub-version:        4.27, 1.2.3
 *   - it is glued to a `UE` engine tag:   UE5, UE5.3, ue4
 * A bare integer with no such signal (`100`, `40000`, `76`, `1000`) survives.
 *
 * Run *after* `_`/`-` separators collapse to spaces, so every candidate is a
 * whitespace-delimited token. That avoids the old `\b` trap where `_` (a word
 * char) glued a separator to a version (`Asset_v1` left `v1` un-stripped).
 */
const VERSION_TOKEN = /(?:^|\s)(?:[vV]\d+(?:\.\d+)*|[uU][eE]\d+(?:\.\d+)*|\d+(?:\.\d+)+)(?=\s|$)/g;

export function cleanAssetName(raw: string): string {
  let cleaned = raw;
  cleaned = cleaned.replace(/\([^)]*\)/g, ' ');
  cleaned = cleaned.replace(/\[[^\]]*\]/g, ' ');
  // Normalize pure separators to spaces first so version tokens are isolated.
  cleaned = cleaned.replace(/[_-]/g, ' ');
  cleaned = cleaned.replace(VERSION_TOKEN, ' ');
  cleaned = cleaned.toLowerCase().replace(/\./g, ' ').split(/\s+/).filter(Boolean).join(' ');
  return cleaned;
}

/**
 * Search Orbital for `folderName`, rank the candidates by fuzzy match
 * against the cleaned name, and return every result with a similarity
 * score. Callers typically take the top hit if its strength is ≥ medium.
 */
export async function matchAssetName(folderName: string, limit = 20): Promise<MatchResult[]> {
  const query = cleanAssetName(folderName);
  if (!query) return [];

  const candidates = await searchProducts({ searchText: query, limit });
  if (candidates.length === 0) return [];

  const fuse = new Fuse(candidates, {
    keys: [
      { name: 'title', weight: 0.7 },
      { name: 'description', weight: 0.2 },
      { name: 'owner.name', weight: 0.1 },
    ],
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
    minMatchCharLength: 3,
  });

  const scored = fuse.search(query).map((r) => {
    // Fuse.js returns distance-style scores (0 = perfect, 1 = no match).
    // Flip to a similarity score to match the Rust matcher's output shape.
    const fuseSimilarity = 1 - (r.score ?? 1);
    // Bitap is word-width limited, so let the length-stable token metric raise
    // the score — but ONLY when it is confident (>= HIGH). Dice rewards shared
    // generic words, so mid-band token scores are mostly noise: `Boat Pack
    // Vol_1` vs "Fence Pack Vol.4" scores 0.667 on `pack` + `vol` alone, and
    // `Industrial Door Pack` vs "Industrial - City Pack" likewise. Measured on a
    // real 99-pack run, every genuine match landed >= 0.75 and every false
    // positive <= 0.667, so the token path only ever promotes, never invents.
    const tokenScore = tokenSimilarity(query, r.item.title ?? '');
    const similarity = Math.max(fuseSimilarity, tokenScore >= HIGH_THRESHOLD ? tokenScore : 0);
    return {
      item: r.item,
      score: similarity,
      strength: strengthOf(similarity),
    };
  });

  // Fuse filters by threshold; anything left is at least `low`.
  // Sort highest-confidence first so callers can take [0].
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Minimum word count before the token metric is trusted. See `tokenSimilarity`. */
const MIN_TOKENS_FOR_TOKEN_SCORE = 3;
/** Words this short carry no signal ("3d", "ui", "of") and skew small token sets. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Length-stable similarity: Sørensen–Dice over word sets.
 *
 * Fuse.js scores with Bitap, which operates on machine words and therefore
 * degrades as the pattern grows. Measured against a candidate list containing
 * the title verbatim:
 *
 *   query length   10 chars -> 0.819
 *                  24 chars -> 0.460
 *                  46 chars -> 0.532   <- an EXACT match
 *
 * 0.532 sits under MEDIUM_THRESHOLD, so a perfect match on a long name was
 * reported as `low` and every caller discarded it. UE pack names are long
 * ("Narrative Tales - Node Based Quests and Dialogue"), so this was the common
 * case, not an edge one: it rejected 66 of 262 packs in a real categorization
 * run. The confidence bands were ported from the Rust jaro-winkler matcher on
 * the assumption Bitap "behaves comparably" — it does not at these lengths.
 *
 * Dice is unaffected by length: identical word sets score 1.0 whether the name
 * is 10 characters or 60. `matchAssetName` takes `max(fuse, token)` so Bitap's
 * character-level typo tolerance still wins where it is the better signal.
 *
 * Gated at >= 3 words because Dice is too generous on tiny sets: the 1-word
 * query `config` against "ConfigCat Remote Config" scores 0.5, and a 2-word
 * query can reach `medium` on a single shared word. Short queries keep the old
 * Fuse-only behaviour, which is exactly where it was already correct.
 */
export function tokenSimilarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((t) => t.length >= MIN_TOKEN_LENGTH),
    );
  const A = words(a);
  const B = words(b);
  if (A.size < MIN_TOKENS_FOR_TOKEN_SCORE || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

export function strengthOf(score: number): MatchStrength {
  if (score >= EXACT_THRESHOLD) return 'exact';
  if (score >= HIGH_THRESHOLD) return 'high';
  if (score >= MEDIUM_THRESHOLD) return 'medium';
  if (score >= LOW_THRESHOLD) return 'low';
  return 'none';
}
