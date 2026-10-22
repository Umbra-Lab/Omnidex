import { Link, useMatchRoute } from '@tanstack/react-router';
import { Boxes, GraduationCap, ScanSearch, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { useRuntime } from '@/runtime/useRuntime';

interface NavItem {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly icon: typeof Boxes;
  /** Renders a count chip after the label — used for the match backlog. */
  readonly badge?: 'unmatched';
}

/**
 * Three destinations, down from six.
 *
 * Of the six, only one was a duplicate in the strict sense: /fab issued
 * `assets.listCards` with the same `scan_location_id: -1` predicate the
 * sidebar's "FAB library" row already applies, minus search, sort and facets —
 * two doors to one room, and the one with a nav slot was the worse of the two.
 * Collections is a real entity, but a list of bags belongs in the sidebar
 * beside the other ways to slice the library, not in the most valuable strip
 * in the app. Projects was an icon, two sentences and a disabled button.
 * Health is library state, which is what the Library destination is for.
 *
 * The freed slot goes to Match — the job that genuinely had no home and is
 * 88% of the library deep.
 */
const ITEMS: ReadonlyArray<NavItem> = [
  { id: 'assets', label: 'Library', to: '/assets', icon: Boxes },
  { id: 'match', label: 'Match', to: '/match', icon: ScanSearch, badge: 'unmatched' },
  { id: 'learn', label: 'Learn', to: '/learn', icon: GraduationCap },
];

// Search lives in AssetToolbar (view-specific filter, view-specific
// surface). NavBar stays focused on navigation + global controls — see
// `features/assets/AssetToolbar.tsx` for the input and URL plumbing.
export function NavBar() {
  const matchRoute = useMatchRoute();
  const stats = trpc.assets.stats.useQuery();
  const { platform } = useRuntime();
  // macOS hides the OS caption (titleBarStyle: 'hiddenInset') and floats the
  // traffic lights over this strip, so the nav needs room for them. Every other
  // platform keeps its native caption bar and needs none.
  const macInset = platform === 'darwin';

  return (
    <header className="relative z-10 flex h-11 items-center gap-4 border-b border-surface-800/60 bg-surface-950/85 px-4 backdrop-blur">
      {/* No wordmark. On Windows and Linux the OS caption already prints
          "Omnidex" one strip above, so 66px of chrome spent its whole budget
          saying the app name twice. The only thing this row owed the layout was
          clearance for the macOS traffic lights. */}
      {macInset ? <span aria-hidden="true" className="w-[68px] shrink-0" /> : null}
      <nav className="flex items-center gap-0.5">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            matchRoute({ to: item.to, fuzzy: false }) ||
            (item.to === '/assets' && matchRoute({ to: '/', fuzzy: false }));
          return (
            <Link
              key={item.id}
              to={item.to}
              className={cn(
                'relative flex items-center gap-1.5 rounded-md px-2.5 py-1 cap-12 font-medium transition-colors',
                active
                  ? 'text-surface-50'
                  : 'text-surface-400 hover:bg-surface-900/80 hover:text-surface-200',
              )}
            >
              <Icon size={14} strokeWidth={2} />
              {item.label}
              {item.badge === 'unmatched' && (stats.data?.unmatched ?? 0) > 0 ? (
                <span className="rounded-sm bg-accent-500 px-1.5 font-mono tabular-nums cap-10 font-semibold text-accent-on">
                  {formatCount(stats.data?.unmatched ?? 0)}
                </span>
              ) : null}
              {active ? (
                <motion.span
                  layoutId="nav-indicator"
                  className="absolute inset-x-2 -bottom-[7px] h-[2px] rounded-full bg-accent-500"
                  transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                />
              ) : null}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {/* A link, not a button: Settings is a place now, so it highlights
            while you are there and the browser-shaped affordances work. */}
        <Link
          to="/settings/$tab"
          params={{ tab: 'folders' }}
          activeOptions={{ exact: false }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-surface-400 no-underline transition-colors hover:bg-surface-900 hover:text-surface-200 [&.active]:bg-surface-900 [&.active]:text-surface-100"
          aria-label="Open settings"
        >
          <Settings size={14} strokeWidth={2} />
        </Link>
      </div>
    </header>
  );
}
