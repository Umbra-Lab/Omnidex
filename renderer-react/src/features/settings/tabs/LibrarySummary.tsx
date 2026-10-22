import { useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/ipc/trpc';
import { formatCount } from '@/lib/format';

/**
 * Library totals, shown above the folder list that produces them.
 *
 * Every figure reads from `assets.stats` — the same query the StatusBar uses —
 * so Settings and the status bar can never disagree. (The previous Overview tab
 * counted `assets.totalCount`, which includes Learn-tab courses, and so showed
 * a different "total assets" than the bar two hundred pixels below it.)
 */
export function LibrarySummary() {
  const stats = trpc.assets.stats.useQuery();
  const navigate = useNavigate();

  const s = stats.data;
  const unmatched = s?.unmatched ?? 0;

  // Settings is a route, so this is an ordinary navigation — nothing to close
  // first, and back returns here.
  function reviewUnmatched() {
    void navigate({ to: '/health' });
  }

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <Stat label="Packs" value={formatCount(s?.total ?? 0)} />
      <Stat label="Favorites" value={formatCount(s?.favorites ?? 0)} />
      <Stat label="FAB owned" value={formatCount(s?.fab_owned ?? 0)} />
      <Stat label="Matched" value={formatCount(s?.with_orbital ?? 0)} />
      {/* The backlog is the one number here the user can act on, so it is a
          control, not a readout. No Match route exists yet — Library health is
          where the unmatched set is triaged. */}
      <button
        type="button"
        onClick={reviewUnmatched}
        className="group flex flex-col gap-1.5 rounded-md border border-surface-800/60 bg-surface-900/40 p-4 text-left shadow-sm transition-colors [transition-duration:var(--duration-micro)] hover:border-surface-700 hover:bg-surface-900 focus-visible:outline-none"
      >
        <span className="cap-12 text-surface-400">Unmatched</span>
        <span
          className={`font-mono cap-23 font-semibold tabular-nums ${
            unmatched > 0 ? 'text-warning-300' : 'text-surface-50'
          }`}
        >
          {formatCount(unmatched)}
        </span>
        <span className="inline-flex items-center gap-1 font-mono cap-10 uppercase tracking-[0.14em] text-accent-400 group-hover:underline">
          Review
          <ArrowRight size={10} />
        </span>
      </button>
    </div>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="font-mono cap-23 tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
