import { describe, expect, it, vi } from 'vitest';

/**
 * `searchProducts` is the single producer of `OrbitalSearchItem`, so it must
 * hand every consumer real numbers — the Orbital API returns `price` / `rating`
 * as strings in some responses, which crashed the match picker's `.toFixed`
 * (PR #28). Mock the client so `post(path, body, parse)` just runs the parser
 * against a canned string-priced response — no network, no throttle.
 */
vi.mock('../client', () => ({
  post: (_path: string, _body: unknown, parse: (raw: string) => unknown) =>
    parse(
      JSON.stringify([
        {
          id: '1',
          slug: 'a',
          title: 'A',
          price: '29.99',
          discount: '0',
          rating: { average: '4.5', count: '120' },
        },
        { id: '2', slug: 'b', title: 'B', price: null, rating: null },
        { id: '3', slug: 'c', title: 'C', price: 'free' },
      ]),
    ),
}));

import { searchProducts } from '../search';

describe('searchProducts number normalization', () => {
  it('coerces string price/rating from the API into real numbers', async () => {
    const items = await searchProducts({ searchText: 'x' });
    expect(items[0].price).toBe(29.99);
    expect(typeof items[0].price).toBe('number');
    expect(items[0].discount).toBe(0);
    expect(items[0].rating?.average).toBe(4.5);
    expect(items[0].rating?.count).toBe(120);
    // The exact operation that crashed in PR #28 must now be safe.
    expect((items[0].price as number).toFixed(2)).toBe('29.99');
  });

  it('maps null/missing and non-numeric values to null (never NaN or string)', async () => {
    const items = await searchProducts({ searchText: 'x' });
    expect(items[1].price).toBeNull();
    expect(items[1].rating).toBeNull();
    expect(items[2].price).toBeNull(); // 'free' → null, not NaN
  });
});
