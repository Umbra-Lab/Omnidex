import { describe, expect, it } from 'vitest';
import { cleanAssetName, strengthOf, tokenSimilarity } from '../matcher';

/**
 * Pure-function coverage for the Orbital fuzzy matcher's normalization and
 * confidence banding. WS6 covered cache/client/product-mapping but never
 * referenced the matcher, so `cleanAssetName` (the query the whole match
 * pipeline runs against) and `strengthOf` (the band the UI gates on) were
 * untested.
 *
 * `cleanAssetName` had a confirmed defect: the version-token regex
 * `/\b[vV]?\d+([._]\d+)*\b/` stripped EVERY bare integer, so "Top 100
 * Materials" collapsed to "top materials" and "Warhammer 40000" to
 * "warhammer" — meaningful, search-defining numbers were destroyed and short
 * names could empty out entirely. It now strips only tokens carrying a
 * version *signal* (`v`/`V` prefix, dotted sub-version, or `UE` engine tag)
 * while standalone integers survive. These tests pin BOTH halves: genuine
 * version tokens are still removed, and meaningful numbers are kept.
 */

describe('cleanAssetName — bracket/paren stripping', () => {
  it('strips parenthesized content', () => {
    expect(cleanAssetName('Stylized Castle (Modular Kit)')).toBe('stylized castle');
  });

  it('strips bracketed content', () => {
    expect(cleanAssetName('Modular Walls [PBR]')).toBe('modular walls');
  });

  it('strips both parens and brackets in one name', () => {
    expect(cleanAssetName('Forest Pack (Nature) [4K]')).toBe('forest pack');
  });

  it('strips a parenthesized version token without leaving a bare digit', () => {
    expect(cleanAssetName('Stylized Castle (v8.2)')).toBe('stylized castle');
  });
});

describe('cleanAssetName — version-token stripping', () => {
  it('strips a v-prefixed integer version (v2)', () => {
    expect(cleanAssetName('Asset v2')).toBe('asset');
  });

  it('strips a v-prefixed dotted version (v8.2)', () => {
    expect(cleanAssetName('Nature Pack v8.2')).toBe('nature pack');
  });

  it('strips a v-prefixed multi-dot version (v1.2.3)', () => {
    expect(cleanAssetName('MyAsset v1.2.3')).toBe('myasset');
  });

  it('strips a dotted engine version with no v-prefix (4.27)', () => {
    expect(cleanAssetName('Forest Pack 4.27')).toBe('forest pack');
  });

  it('strips a UE engine tag (UE5)', () => {
    expect(cleanAssetName('UE5 Starter')).toBe('starter');
  });

  it('strips a dotted UE engine tag (UE5.3)', () => {
    expect(cleanAssetName('Sci-Fi Weapons UE5.3')).toBe('sci fi weapons');
  });

  it('strips two adjacent version tokens in the same name', () => {
    expect(cleanAssetName('Nature Pack v8.2 UE5.3')).toBe('nature pack');
  });

  it('strips a leading version token', () => {
    expect(cleanAssetName('v8.2 UE5.3 Pack')).toBe('pack');
  });

  it('empties out a name that is nothing but version tokens', () => {
    expect(cleanAssetName('v1 v2 v3')).toBe('');
  });
});

describe('cleanAssetName — separator handling', () => {
  it('collapses underscores, hyphens, and dots to spaces', () => {
    expect(cleanAssetName('My-Cool_Asset.Pack')).toBe('my cool asset pack');
  });

  it('collapses runs of separators and trims', () => {
    expect(cleanAssetName('  Spaced___Out---Name  ')).toBe('spaced out name');
  });

  it('lowercases the result', () => {
    expect(cleanAssetName('CASTLE Pack')).toBe('castle pack');
  });

  it('isolates an underscore-glued version token (Asset_v1)', () => {
    // Regression guard: the old `\b`-based regex left `v1` un-stripped here
    // because `_` is a word char, so there was no boundary before `v`.
    expect(cleanAssetName('Materials_v2_4K')).toBe('materials 4k');
  });

  it('returns empty string for an all-separator input', () => {
    expect(cleanAssetName('___---...')).toBe('');
  });
});

describe('cleanAssetName — standalone numbers survive (defect fix)', () => {
  it('keeps a standalone count in "Top 100 Materials"', () => {
    // Pre-fix this collapsed to "top materials".
    expect(cleanAssetName('Top 100 Materials')).toBe('top 100 materials');
  });

  it('keeps the franchise number in "Warhammer 40000"', () => {
    // Pre-fix this collapsed to "warhammer" — a meaningful, search-defining
    // token was destroyed.
    expect(cleanAssetName('Warhammer 40000')).toBe('warhammer 40000');
  });

  it('keeps a mid-name standalone number ("Fallout 76 Vault")', () => {
    expect(cleanAssetName('Fallout 76 Vault')).toBe('fallout 76 vault');
  });

  it('keeps a leading standalone number ("1000 Trees")', () => {
    expect(cleanAssetName('1000 Trees')).toBe('1000 trees');
  });

  it('keeps a standalone number alongside a real version token', () => {
    // "100" survives; "v2" is stripped.
    expect(cleanAssetName('Top 100 Materials v2')).toBe('top 100 materials');
  });

  it('does not empty a name whose only distinctive token is a number', () => {
    expect(cleanAssetName('Level 9000')).toBe('level 9000');
  });
});

describe('strengthOf — band-threshold boundaries', () => {
  // Bands: exact ≥ 0.90, high ≥ 0.75, medium ≥ 0.55, low ≥ 0.35, none < 0.35.

  it('1.0 is exact', () => {
    expect(strengthOf(1)).toBe('exact');
  });

  it('exactly 0.90 is exact (lower bound, inclusive)', () => {
    expect(strengthOf(0.9)).toBe('exact');
  });

  it('just below 0.90 is high', () => {
    expect(strengthOf(0.8999)).toBe('high');
  });

  it('exactly 0.75 is high (lower bound, inclusive)', () => {
    expect(strengthOf(0.75)).toBe('high');
  });

  it('just below 0.75 is medium', () => {
    expect(strengthOf(0.7499)).toBe('medium');
  });

  it('exactly 0.55 is medium (lower bound, inclusive)', () => {
    expect(strengthOf(0.55)).toBe('medium');
  });

  it('just below 0.55 is low', () => {
    expect(strengthOf(0.5499)).toBe('low');
  });

  it('exactly 0.35 is low (lower bound, inclusive)', () => {
    expect(strengthOf(0.35)).toBe('low');
  });

  it('just below 0.35 is none', () => {
    expect(strengthOf(0.3499)).toBe('none');
  });

  it('0.0 is none', () => {
    expect(strengthOf(0)).toBe('none');
  });
});

/**
 * `tokenSimilarity` exists because Fuse.js's Bitap scoring is word-width
 * limited and collapses on long patterns. Measured against a candidate list
 * containing the title verbatim, an EXACT 46-character match scored 0.532 —
 * under MEDIUM_THRESHOLD, so `matchAssetName` reported `low` and every caller
 * threw the match away. That rejected 66 of 262 packs in a real run.
 *
 * These pin the property that broke: score must not decay as the name grows.
 */
describe('tokenSimilarity — length-stable scoring (Bitap defect fix)', () => {
  const LONG = 'Narrative Tales - Node Based Quests and Dialogue';

  it('scores an exact long match 1.0 where Fuse scored 0.532', () => {
    expect(tokenSimilarity(cleanAssetName(LONG), LONG)).toBe(1);
  });

  it('does not decay as the name gets longer', () => {
    // The regression: Fuse gave 0.819 at 10 chars but 0.532 at 46. Dice must
    // stay at 1.0 for an exact match regardless of length.
    const short = 'Swimming Animation Pack';
    const long = 'Ultimate Realistic Swimming Animation Pack for Unreal Engine Characters';
    expect(tokenSimilarity(cleanAssetName(short), short)).toBe(1);
    expect(tokenSimilarity(cleanAssetName(long), long)).toBe(1);
  });

  it('clears the medium band for a real-world near match', () => {
    // `UE4` is stripped from the query but survives in the title, so this is a
    // near — not exact — match. It must still be usable.
    const score = tokenSimilarity(
      cleanAssetName('Ultimate Water Shader UE4 and 5'),
      'Ultimate Water Shader UE4 and 5',
    );
    expect(score).toBeGreaterThanOrEqual(0.55);
    expect(strengthOf(score)).not.toBe('low');
  });

  it('ignores queries under three words, where Dice is too generous', () => {
    // The false-positive guard: a 1-word folder name like `Config` matched
    // "ConfigCat Remote Config" as `exact` and mis-filed a UE project folder.
    // Short queries must return 0 so Fuse alone decides.
    expect(tokenSimilarity('config', 'ConfigCat Remote Config')).toBe(0);
    expect(tokenSimilarity('lgui', 'LGUI - 3D UI for UnrealEngine')).toBe(0);
    expect(tokenSimilarity('source', 'Light Sources')).toBe(0);
  });

  it('scores an unrelated title near zero', () => {
    expect(tokenSimilarity(cleanAssetName(LONG), 'Medieval Village Environment Pack')).toBeLessThan(
      0.35,
    );
  });

  it('drops sub-3-character words that carry no signal', () => {
    // `3d` and `ui` would otherwise inflate tiny token sets.
    expect(tokenSimilarity('modular sci fi corridor kit', 'Modular Sci-Fi Corridor Kit')).toBe(1);
  });

  it('returns 0 rather than NaN when the candidate title is empty', () => {
    expect(tokenSimilarity(cleanAssetName(LONG), '')).toBe(0);
  });
});

/**
 * The token metric is gated at HIGH in `matchAssetName` because Sørensen–Dice
 * rewards shared GENERIC words. On a real 99-pack run every genuine match
 * scored >= 0.75 while every false positive scored <= 0.667, all of them
 * sharing only filler like `pack` / `vol` / `kit`. These pin that separation so
 * a future threshold change has to confront the counter-examples.
 */
describe('tokenSimilarity — generic-word false positives stay below HIGH', () => {
  const cases: Array<[string, string, string]> = [
    ['Boat Pack Vol_1 4.18+', 'Fence Pack Vol.4', 'boat vs fence, shares pack+vol'],
    ['Industrial Door Pack 4.2x+', 'Industrial - City Pack', 'door vs city'],
    ['Sci-fi Design Kit', 'NOVA - Modular Sci-Fi Kit', 'different product, shares sci fi kit'],
  ];

  for (const [folder, title, why] of cases) {
    it(`stays under 0.75: ${why}`, () => {
      expect(tokenSimilarity(cleanAssetName(folder), title)).toBeLessThan(0.75);
    });
  }

  it('genuine matches clear 0.75 so the gate does not cost them', () => {
    const genuine: Array<[string, string]> = [
      ['Lowpoly Style Tropical Pack 4.16+', 'Lowpoly Style Tropical Pack'],
      [
        'Narrative Tales - Node Based Quests and Dialogue',
        'Narrative Tales - Node Based Quests and Dialogue',
      ],
      [
        'Arghanions Cosmic Forge - Animated Nebula Skyboxes',
        "Arghanion's Cosmic Forge - Animated Nebula Skyboxes",
      ],
      [
        'Mobile Swipe Solution for Android and iOS 4.23+',
        'Mobile Swipe Solution for Android and iOS',
      ],
    ];
    for (const [folder, title] of genuine) {
      expect(tokenSimilarity(cleanAssetName(folder), title)).toBeGreaterThanOrEqual(0.75);
    }
  });
});
