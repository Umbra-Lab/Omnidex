import { describe, expect, it } from 'vitest';
import type { OrbitalProduct, OrbitalSearchOptions } from '../orbital';

describe('Orbital Types', () => {
  it('should accept valid OrbitalProduct structure', () => {
    const product: OrbitalProduct = {
      _id: '123',
      title: 'Test Asset',
      price: 39.99,
      discount: 20,
      media: {
        thumbnail: 'https://example.com/thumb.jpg',
      },
      review: {
        count: 127,
        rating: 4.8,
      },
      computed: {
        score: 95,
      },
      meta: {
        fabId: 'fab-123',
      },
      owner: {
        name: 'Epic Creator',
      },
      engine: {
        min: '5.3',
        max: '5.4',
      },
    };

    expect(product._id).toBe('123');
    expect(product.price).toBe(39.99);
  });

  it('should accept valid search options', () => {
    const options: OrbitalSearchOptions = {
      categories: ['3D', 'Materials'],
      limit: 10,
      engineMin: '5.3',
      engineMax: '5.4',
    };

    expect(options.limit).toBe(10);
  });
});
