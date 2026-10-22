import * as ProgressPrimitive from '@radix-ui/react-progress';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '@/lib/cn';

export const Progress = forwardRef<
  ElementRef<typeof ProgressPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    // rounded-xs (2px), not rounded-full. DESIGN.md v2 assigns radius.xs to
    // "ecosystem mark, progress bar" and caps the whole app at 6px. The
    // Indicator inherits the corner from this element's overflow-hidden.
    className={cn('relative h-1.5 w-full overflow-hidden rounded-xs bg-surface-800', className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 bg-accent-500 transition-transform [transition-duration:var(--duration-macro)]"
      style={{ transform: `translateX(-${100 - (value ?? 0)}%)` }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;
