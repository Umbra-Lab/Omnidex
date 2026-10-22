import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 cap-10 font-medium uppercase tracking-[0.14em] transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-800 text-surface-200 border border-surface-700/60',
        accent: 'bg-accent-500/15 text-accent-300 border border-accent-500/30',
        success: 'bg-success-500/15 text-success-500 border border-success-500/30',
        warning: 'bg-warning-500/15 text-warning-500 border border-warning-500/30',
        danger: 'bg-danger-500/15 text-danger-500 border border-danger-500/30',
        outline: 'border border-surface-700 text-surface-300',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
