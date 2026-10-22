import { describe, expect, it } from 'vitest';
import type { OrbitalProductDetail } from '../models';
import { mapOrbitalDetailToAssetFields, stripHtml } from '../product-mapping';

/**
 * Locks in the shared Orbital field-mapping contract used by BOTH the bulk
 * enrich path and the manual-match path. The pre-fix manual path read the
 * WRONG shapes (`media.images[0].url`, `rating.average`, top-level `price`)
 * and silently wrote nulls; these assertions prove the real detail shape
 * (`media.images: string[]`, `media.thumbnail`, `review.{rating,count}`,
 * `price.value` cents) maps to populated columns.
 */

const FULL_DETAIL: OrbitalProductDetail = {
  slug: 'epic-castle-pack',
  title: 'Epic Castle Pack',
  description: {
    long: '<p>A grand <b>castle</b> kit.</p><p>Modular &amp; fast.</p>',
    technical: '<ul><li>120 meshes</li><li>4K textures</li></ul>',
  },
  price: {
    value: 4999,
    history: [
      { date: '2026-01-01', value: 5999 },
      { date: '2026-05-01', value: 4999 },
    ],
  },
  review: { rating: 4.7, count: 312 },
  media: {
    images: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
    thumbnail: 'https://cdn.example.com/thumb.jpg',
  },
  owner: { name: 'Castle Studios' },
  category: 'Environments',
  engine: { min: '5.1', max: '5.4' },
  releaseDate: '2025-12-15',
};

describe('mapOrbitalDetailToAssetFields', () => {
  it('maps the real Orbital detail shape onto populated asset fields', () => {
    const m = mapOrbitalDetailToAssetFields(FULL_DETAIL);

    expect(m.slug).toBe('epic-castle-pack');
    expect(m.title).toBe('Epic Castle Pack');
    // HTML stripped to plain text with paragraph breaks + entity decode.
    expect(m.description).toBe('A grand castle kit.\n\nModular & fast.');
    expect(m.technical).toContain('120 meshes');
    // thumbnail (NOT media.images[0].url which never existed).
    expect(m.heroUrl).toBe('https://cdn.example.com/thumb.jpg');
    // gallery is bare string[] re-wrapped as {url}[] for the renderer reader.
    expect(m.gallery).toBe(
      JSON.stringify([
        { url: 'https://cdn.example.com/a.jpg' },
        { url: 'https://cdn.example.com/b.jpg' },
      ]),
    );
    expect(m.seller).toBe('Castle Studios');
    // price.value cents (NOT a top-level number).
    expect(m.priceCents).toBe(4999);
    expect(m.releaseDate).toBe('2025-12-15');
    // last-modified derived from the latest price-history date.
    expect(m.lastModified).toBe('2026-05-01');
    // review.{rating,count} (NOT rating.{average,count}).
    expect(m.ratingAvg).toBe(4.7);
    expect(m.ratingCount).toBe(312);
    expect(m.categories).toBe(JSON.stringify(['Environments']));
    expect(m.supportedVersions).toBe(JSON.stringify(['UE 5.1–5.4']));
    expect(m.sourceUrl).toBe('https://orbital-market.com/product/epic-castle-pack');
  });

  it('renders a single-min engine version when min==max or only min is present', () => {
    expect(
      mapOrbitalDetailToAssetFields({ slug: 's', engine: { min: '5.3', max: '5.3' } })
        .supportedVersions,
    ).toBe(JSON.stringify(['UE 5.3+']));
    expect(
      mapOrbitalDetailToAssetFields({ slug: 's', engine: { min: '5.2' } }).supportedVersions,
    ).toBe(JSON.stringify(['UE 5.2+']));
  });

  it('degrades every field to null/absent on an empty or drifted shape', () => {
    const m = mapOrbitalDetailToAssetFields({});
    expect(m.slug).toBeNull();
    expect(m.title).toBeNull();
    expect(m.description).toBeNull();
    expect(m.technical).toBeNull();
    expect(m.heroUrl).toBeNull();
    expect(m.gallery).toBeNull();
    expect(m.seller).toBeNull();
    expect(m.priceCents).toBeNull();
    expect(m.releaseDate).toBeNull();
    expect(m.lastModified).toBeNull();
    expect(m.ratingAvg).toBeNull();
    expect(m.ratingCount).toBeNull();
    expect(m.categories).toBeNull();
    expect(m.supportedVersions).toBeNull();
    // No slug => no source URL (avoids `.../product/undefined`).
    expect(m.sourceUrl).toBeNull();
  });

  it('ignores non-string gallery entries from a drifted API', () => {
    const m = mapOrbitalDetailToAssetFields({
      slug: 's',
      // biome-ignore lint/suspicious/noExplicitAny: simulating API drift
      media: { images: ['ok.jpg', null, 42] as any },
    });
    expect(m.gallery).toBe(JSON.stringify([{ url: 'ok.jpg' }]));
  });
});

describe('stripHtml', () => {
  it('returns null for empty / non-string input', () => {
    expect(stripHtml('')).toBeNull();
    expect(stripHtml(undefined)).toBeNull();
    expect(stripHtml(123)).toBeNull();
  });

  it('decodes entities and collapses whitespace', () => {
    expect(stripHtml('<p>a &amp; b</p>')).toBe('a & b');
  });
});
