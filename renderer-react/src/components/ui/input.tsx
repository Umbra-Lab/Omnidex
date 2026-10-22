import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-8 w-full rounded-md border border-surface-800/60 bg-surface-950 px-2.5 cap-14 text-surface-50 placeholder:text-surface-500',
        'transition-colors [transition-duration:var(--duration-micro)]',
        'hover:border-surface-700 focus:border-accent-500 focus:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'file:border-0 file:bg-transparent file:cap-14 file:font-medium',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
