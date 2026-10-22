import * as SwitchPrimitive from '@radix-ui/react-switch';
import { type ComponentPropsWithoutRef, type ElementRef, forwardRef } from 'react';
import { cn } from '@/lib/cn';

export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors',
      // WCAG 2.5.8: keep the visual pill at 16px but expand the pointer target
      // to ≥24px tall via a transparent hit-area that is part of the control.
      'before:absolute before:-inset-y-1 before:inset-x-0 before:content-[""]',
      'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      // Neutral on-state. The accent is reserved for the single primary action
      // in a region (DESIGN.md "Color"); painting the checked track accent-500
      // meant seven scan-location toggles competed with the one real CTA. Knob
      // position carries the state, and the knob brightens to reinforce it.
      'data-[state=checked]:bg-surface-600 data-[state=unchecked]:bg-surface-700',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-3 rounded-full shadow-sm ring-0 transition-transform',
        'data-[state=checked]:bg-surface-50 data-[state=unchecked]:bg-surface-300',
        'data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
