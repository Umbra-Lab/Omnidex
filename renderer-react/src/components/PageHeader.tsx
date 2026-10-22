import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface PageHeaderProps {
  /** Page title rendered as the single H1 for the view. */
  readonly title: string;
  /** Optional supporting line under the title. */
  readonly description?: string;
  /** Optional lucide icon shown left of the title (accent-tinted). */
  readonly icon?: LucideIcon;
  /** Right-aligned slot — primary action, badges, etc. */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/**
 * The one page-title contract: a single H1 token, one height/padding rhythm,
 * and a consistent title/description/actions layout shared across every
 * top-level view. Reach for this instead of hand-rolling a per-view `<header>`
 * so the title treatment stays identical everywhere.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('mb-6 flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Icon ? <Icon size={18} className="shrink-0 text-accent-400" aria-hidden /> : null}
          <h1 className="font-display cap-23 font-semibold tracking-tight text-surface-50">
            {title}
          </h1>
        </div>
        {description ? <p className="mt-1 cap-12 text-surface-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
