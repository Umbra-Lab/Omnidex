import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

interface GridErrorStateProps {
  /** Headline; defaults to a generic load-failure message. */
  readonly title?: string;
  /** Detail line — pass `query.error.message` for the tRPC reason. */
  readonly message?: ReactNode;
  /** Wire to `query.refetch` to add a retry affordance. */
  readonly onRetry?: () => void;
  readonly className?: string;
}

/**
 * Centered error state for query-backed grids/lists (AssetGrid, LearnView,
 * CollectionDetail, …). Matches the grids' centered empty-state layout so an
 * `isError` branch is a one-line drop-in:
 *
 *   if (query.isError)
 *     return <GridErrorState message={query.error.message} onRetry={query.refetch} />;
 */
export function GridErrorState({
  title = "Couldn't load this view",
  message,
  onRetry,
  className,
}: GridErrorStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-3 text-center text-surface-400',
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-danger-500/10 text-danger-400">
        <AlertTriangle size={18} />
      </div>
      <div className="cap-14 font-medium text-surface-200">{title}</div>
      {message ? (
        <div className="max-w-sm font-mono cap-11 text-surface-500">{message}</div>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RotateCw size={12} />
          Retry
        </Button>
      ) : null}
    </div>
  );
}
