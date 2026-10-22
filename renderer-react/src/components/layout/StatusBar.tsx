import { create } from 'zustand';
import { trpc } from '@/ipc/trpc';
import { formatBytes, formatCount } from '@/lib/format';

/**
 * What the active view is currently showing. Views publish into this; the bar
 * reads it. A store rather than props because the bar lives in AppShell,
 * above the router outlet, and every route reports something different.
 */
interface ViewStatusState {
  /** Rows matching the current filter, or null when the view has no filter. */
  readonly shown: number | null;
  readonly selected: number;
  /** e.g. "grid" / "table" — right-hand context, omitted when absent. */
  readonly viewMode: string | null;
  readonly setViewStatus: (next: {
    shown?: number | null;
    selected?: number;
    viewMode?: string | null;
  }) => void;
  readonly resetViewStatus: () => void;
}

export const useViewStatus = create<ViewStatusState>((set) => ({
  shown: null,
  selected: 0,
  viewMode: null,
  setViewStatus: (next) => set(next),
  resetViewStatus: () => set({ shown: null, selected: 0, viewMode: null }),
}));

/**
 * Persistent 28px status bar. DESIGN.md has specified this since v1 including
 * the height; it was never built, which is why the app had no single place to
 * say how many assets exist and four surfaces disagreed about it.
 *
 * Everything here comes from `assets.stats` — one query, one population. Packs
 * and courses are named separately rather than added into a number that means
 * neither.
 */
export function StatusBar() {
  const stats = trpc.assets.stats.useQuery();
  const shown = useViewStatus((s) => s.shown);
  const selected = useViewStatus((s) => s.selected);
  const viewMode = useViewStatus((s) => s.viewMode);

  const s = stats.data;

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-surface-800/60 bg-surface-850 px-4 font-mono tabular-nums cap-12 text-surface-300">
      {s ? (
        <>
          <span>
            {formatCount(s.total)} packs
            {s.courses > 0 ? ` · ${formatCount(s.courses)} courses` : ''}
            {s.size_bytes > 0 ? ` · ${formatBytes(s.size_bytes)}` : ''}
          </span>

          {shown != null || selected > 0 ? (
            <>
              <Divider />
              <span>
                {shown != null ? `${formatCount(shown)} shown` : null}
                {shown != null && selected > 0 ? ' · ' : null}
                {selected > 0 ? `${formatCount(selected)} selected` : null}
              </span>
            </>
          ) : null}

          {s.unmatched > 0 ? (
            <>
              <Divider />
              {/* The most important number in the app. Amber because it is a
                  backlog, not an error — and it is a link, not a readout. */}
              <a href="#/health" className="text-warning-300 no-underline hover:text-warning-500">
                {formatCount(s.unmatched)} unmatched
              </a>
            </>
          ) : null}
        </>
      ) : (
        <span className="text-surface-500">Loading library…</span>
      )}

      {viewMode ? <span className="ml-auto text-surface-400">{viewMode}</span> : null}
    </footer>
  );
}

function Divider() {
  return <span className="text-surface-600">|</span>;
}
