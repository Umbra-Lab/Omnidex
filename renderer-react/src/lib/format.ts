const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * `isPartial` marks a size the scanner could only measure to a lower bound
 * (it hit its per-pack walk cap). Renders "26.7 GB+" so the UI never shows a
 * precise figure that is known to be short of the truth.
 */
export function formatBytes(bytes: number, isPartial = false): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${BYTE_UNITS[unit]}${isPartial ? '+' : ''}`;
}

const NUMBER_FMT = new Intl.NumberFormat('en-US');

// There is deliberately no compact ("2.8K") formatter. DESIGN.md: "Show exact
// counts everywhere — 2,799, never 2.8K." The sidebar column is right-aligned
// tabular mono with 240px to spend; the exact figure costs nothing and "2.8K"
// was the app disagreeing with itself about how many assets exist.
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0';
  return NUMBER_FMT.format(n);
}

export function formatPrice(n: number | null | undefined): string {
  if (n == null || n <= 0) return 'Free';
  return `$${n.toFixed(2)}`;
}

/**
 * Enum fallbacks the DB uses that are not categories a user ever chose. They
 * were shipped verbatim as navigation labels, so the sidebar offered "Unknown"
 * and "Agnostic" as if they were things you could want.
 */
const TAXONOMY_OVERRIDES: Readonly<Record<string, string>> = {
  unknown: 'Unclassified',
  agnostic: 'Engine-agnostic',
  unreal_engine: 'Unreal Engine',
};

/** Acronyms and product names that must not be sentence-cased into mush. */
const TAXONOMY_CASING: Readonly<Record<string, string>> = {
  '3d': '3D',
  '2d': '2D',
  ui: 'UI',
  ux: 'UX',
  vfx: 'VFX',
  sfx: 'SFX',
  hdri: 'HDRI',
  pbr: 'PBR',
  fx: 'FX',
  ai: 'AI',
  vr: 'VR',
  ar: 'AR',
  ue: 'UE',
  fab: 'FAB',
  dcc: 'DCC',
};

/**
 * The single formatter every taxonomy label goes through — ecosystems,
 * categories, kinds, anywhere a raw DB value reaches the eye.
 *
 * There used to be two policies 300px apart on the same screen: the sidebar
 * applied CSS `capitalize`, which leaves "Unreal_engine" with its underscore
 * intact, while the asset card ran its own `formatCardLabel` that cleaned
 * separators properly. Same value, two spellings, one viewport.
 *
 * Sentence case, not title case — "3D model", not "3D Model" — because these
 * are labels in a dense list, and title case makes a sidebar shout.
 */
export function formatTaxonomyLabel(raw: string | null | undefined): string {
  if (!raw) return 'Unclassified';
  const key = raw.trim().toLowerCase();
  if (!key) return 'Unclassified';

  const override = TAXONOMY_OVERRIDES[key];
  if (override) return override;

  const words = key.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return 'Unclassified';

  return words
    .map((word, i) => {
      const cased = TAXONOMY_CASING[word];
      if (cased) return cased;
      // Only the first word is capitalized; the rest stay lower.
      return i === 0 ? word[0].toUpperCase() + word.slice(1) : word;
    })
    .join(' ');
}

export function formatRating(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(1);
}

type Version = readonly [major: number, minor: number];

// Highest minor per major, so 4.27 → 5.0 counts as contiguous. Majors absent
// here never roll over, which is the safe direction: worst case we split one
// range into two instead of inventing coverage the asset doesn't have.
const UE_LAST_MINOR: Record<number, number> = { 4: 27 };

function parseVersion(s: string): Version | null {
  // Strict full-match on purpose: Orbital stores pre-collapsed labels like
  // "5.1–5.4", and a loose match would read that as the single point 5.1.
  const m = /^(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function isAdjacent(a: Version, b: Version): boolean {
  if (a[0] === b[0]) return b[1] === a[1] + 1;
  return b[0] === a[0] + 1 && b[1] === 0 && a[1] === UE_LAST_MINOR[a[0]];
}

/**
 * Render `assets.orbital_supported_versions` (a JSON array of strings) as a
 * compact engine range: ["5.0","5.1","5.2"] → "5.0 – 5.2".
 *
 * Two enrichers write this column in different shapes. FAB (`fab/enrich.ts`)
 * stores a raw deduped list of engine versions; Orbital
 * (`orbital/product-mapping.ts`) stores a single already-collapsed label
 * ("UE 5.1–5.4", "UE 5.1+"). Anything that isn't a bare `N.N` point is passed
 * through verbatim rather than dropped — the Orbital form is already the
 * answer, and an unrecognized label beats a silently empty row.
 */
export function formatSupportedVersions(json: string | null | undefined): string {
  if (!json) return '—';
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return '—';
  }
  const labels = (Array.isArray(parsed) ? parsed : [parsed])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/^UE\s*/i, '').trim())
    .filter((v) => v.length > 0);
  if (labels.length === 0) return '—';

  const points: Version[] = [];
  for (const label of labels) {
    const point = parseVersion(label);
    if (!point) return labels.join(', ');
    points.push(point);
  }

  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const show = (v: Version) => `${v[0]}.${v[1]}`;
  const parts: string[] = [];
  let start = points[0];
  let prev = points[0];
  for (const cur of points.slice(1)) {
    if (cur[0] === prev[0] && cur[1] === prev[1]) continue;
    if (isAdjacent(prev, cur)) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? show(start) : `${show(start)} – ${show(prev)}`);
    start = cur;
    prev = cur;
  }
  parts.push(start === prev ? show(start) : `${show(start)} – ${show(prev)}`);
  return parts.join(', ');
}
