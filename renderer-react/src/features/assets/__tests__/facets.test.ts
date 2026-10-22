import { describe, expect, it } from 'vitest';
import { ALL_KEY, activeFacets, buildAssetFilter, toggleFacet } from '../facets';

const set = (...keys: string[]) => new Set(keys);

describe('toggleFacet', () => {
  it('adds a facet to an empty selection', () => {
    expect([...toggleFacet(set(), 'favorites')]).toEqual(['favorites']);
  });

  it('removes a facet that is already active', () => {
    expect([...toggleFacet(set('favorites'), 'favorites')]).toEqual([]);
  });

  it('composes across axes — the whole point of the change', () => {
    let active: ReadonlySet<string> = set();
    active = toggleFacet(active, 'favorites');
    active = toggleFacet(active, 'ecosystem:blender');
    active = toggleFacet(active, 'match:unmatched');
    expect([...active].sort()).toEqual(['ecosystem:blender', 'favorites', 'match:unmatched']);
  });

  it('replaces within an axis rather than accumulating', () => {
    const active = toggleFacet(set('category:props'), 'category:environments');
    expect([...active]).toEqual(['category:environments']);
  });

  it('never holds both match states, which would always return zero rows', () => {
    const active = toggleFacet(set('match:orbital'), 'match:unmatched');
    expect([...active]).toEqual(['match:unmatched']);
  });

  it('keeps other axes intact when one axis is replaced', () => {
    const active = toggleFacet(set('favorites', 'category:props'), 'category:vfx');
    expect([...active].sort()).toEqual(['category:vfx', 'favorites']);
  });

  it('treats the All key as a reset, and never stores it', () => {
    expect([...toggleFacet(set('favorites', 'ecosystem:blender'), ALL_KEY)]).toEqual([]);
  });

  it('does not mutate the set it was handed', () => {
    const before = set('favorites');
    toggleFacet(before, 'fab');
    expect([...before]).toEqual(['favorites']);
  });
});

describe('buildAssetFilter', () => {
  it('is an all-null filter when nothing is selected', () => {
    const filter = buildAssetFilter(set());
    expect(Object.values(filter).every((v) => v === null)).toBe(true);
  });

  it('maps every axis onto its own field so the SQL ANDs them', () => {
    const filter = buildAssetFilter(set('favorites', 'ecosystem:blender', 'match:unmatched'));
    expect(filter.is_favorite).toBe(true);
    expect(filter.ecosystem).toBe('blender');
    expect(filter.match_status).toBe('unmatched');
    expect(filter.category).toBeNull();
  });

  it('maps FAB to the sentinel scan location the counts use', () => {
    expect(buildAssetFilter(set('fab')).scan_location_id).toBe(-1);
  });

  it('keeps a category value containing a colon intact', () => {
    expect(buildAssetFilter(set('category:props:small')).category).toBe('props:small');
  });

  it('never drives name_search — FTS owns text', () => {
    expect(buildAssetFilter(set('favorites')).name_search).toBeNull();
  });
});

describe('activeFacets', () => {
  it('is empty when nothing is selected, so the chip row can hide entirely', () => {
    expect(activeFacets(set())).toEqual([]);
  });

  it('labels the two taxonomy axes distinctly — a bare "Blender" is ambiguous', () => {
    const labels = activeFacets(set('ecosystem:blender', 'category:blender')).map((f) => f.label);
    expect(labels).toContain('Ecosystem: Blender');
    expect(labels).toContain('Category: Blender');
  });

  it('orders by axis, not set-insertion order, so chips do not jump', () => {
    const forward = activeFacets(set('category:props', 'favorites', 'ecosystem:blender'));
    const reverse = activeFacets(set('ecosystem:blender', 'favorites', 'category:props'));
    expect(forward.map((f) => f.key)).toEqual(reverse.map((f) => f.key));
    expect(forward.map((f) => f.axis)).toEqual(['favorites', 'ecosystem', 'category']);
  });

  it('carries the original key back so removing a chip is the same toggle', () => {
    const [chip] = activeFacets(set('match:orbital'));
    expect(chip.key).toBe('match:orbital');
    expect(chip.label).toBe('Orbital matched');
    expect([...toggleFacet(set('match:orbital'), chip.key)]).toEqual([]);
  });
});
