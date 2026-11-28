import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { summarizeRemoval } from '@/features/settings/tabs/removalSummary';
import { RemoveAssetsBody } from '../RemoveAssetsBody';

const none = {
  assets: 1,
  favorites: 0,
  notes: 0,
  taggedAssets: 0,
  collectionEntries: 0,
  lessonsWithProgress: 0,
  matchDecisions: 0,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function text(el: React.ReactElement): string {
  act(() => root.render(el));
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('RemoveAssetsBody', () => {
  it('says one scanned asset comes back, without curation lost', () => {
    const t = text(<RemoveAssetsBody count={1} summary={summarizeRemoval(none)} />);
    expect(t).toContain('The next scan of its folder adds it back as new asset.');
    expect(t).not.toContain('This deletes');
  });

  it('lists the curation that does not come back', () => {
    const t = text(
      <RemoveAssetsBody
        count={2}
        summary={summarizeRemoval({ ...none, assets: 2, notes: 2, favorites: 1 })}
      />,
    );
    expect(t).toContain('adds them back as new assets');
    expect(t).toMatch(/This deletes .*2 notes.*, which don't come back\./);
  });

  it('does not promise vault rows come back', () => {
    const t = text(
      <RemoveAssetsBody count={1} summary={summarizeRemoval(none)} notRescanned={1} />,
    );
    expect(t).toContain('No scan adds it back.');
    expect(t).not.toContain('next scan');
  });

  it('says how many of a mixed selection stay gone', () => {
    const t = text(
      <RemoveAssetsBody
        count={5}
        summary={summarizeRemoval({ ...none, assets: 5 })}
        notRescanned={2}
      />,
    );
    expect(t).toContain('adds back all but 2 of them');
  });

  it('falls back to general wording when the counts are unknown', () => {
    const t = text(<RemoveAssetsBody count={3} summary={null} />);
    expect(t).toContain('Any notes, tags, favorites');
    expect(t).toContain('adds them back');
  });
});
