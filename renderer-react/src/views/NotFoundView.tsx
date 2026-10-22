import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';

export function NotFoundView() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3">
      <span className="font-display cap-18 font-semibold text-surface-200">Route not found</span>
      <p className="cap-12 text-surface-400">That hash doesn't match any known view.</p>
      <Button asChild variant="primary" size="sm">
        <Link to="/assets">Back to assets</Link>
      </Button>
    </div>
  );
}
