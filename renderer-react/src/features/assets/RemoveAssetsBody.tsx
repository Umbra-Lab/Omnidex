import { Fragment } from 'react';
import { Counted } from '@/features/settings/tabs/Counted';
import { separatorBefore, type summarizeRemoval } from '@/features/settings/tabs/removalSummary';

/**
 * Confirm body for removing assets from the library.
 *
 * The old text said they "will be removed from your library", but nothing
 * keeps them out: the next scan of their folder finds them on disk and adds
 * them back as new assets. What does not come back is everything the user
 * made on them, which cascades with the row. So the dialog says that, with
 * the counts, the way removing a folder does.
 */
export function RemoveAssetsBody({
  count,
  summary,
}: {
  readonly count: number;
  /** Null when the counts could not be read. */
  readonly summary: ReturnType<typeof summarizeRemoval> | null;
}) {
  const them = count === 1 ? 'it' : 'them';
  const comesBack = (
    <>
      The next scan of {count === 1 ? 'its' : 'their'} folder adds {them} back as new{' '}
      {count === 1 ? 'asset' : 'assets'}. Files on disk aren&apos;t touched.
    </>
  );

  if (summary == null) {
    return (
      <span className="flex flex-col gap-2">
        <span>{comesBack}</span>
        <span>
          Any notes, tags, favorites, collection entries, watch progress and match decisions on{' '}
          {them} are deleted and don&apos;t come back.
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-2">
      <span>{comesBack}</span>
      {summary.curation.length > 0 ? (
        <span>
          This deletes{' '}
          {summary.curation.map((p, i) => (
            <Fragment key={p.label}>
              {separatorBefore(i, summary.curation.length)}
              <Counted phrase={p} />
            </Fragment>
          ))}
          , which don&apos;t come back.
        </span>
      ) : null}
    </span>
  );
}
