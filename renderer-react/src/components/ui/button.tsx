import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md cap-14 font-medium transition-colors [transition-duration:var(--duration-micro)] focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 select-none',
  {
    variants: {
      variant: {
        primary:
          'bg-accent-500 text-surface-950 hover:bg-accent-400 active:bg-accent-600 shadow-sm shadow-accent-950/30',
        secondary:
          'bg-surface-800 text-surface-50 hover:bg-surface-700 active:bg-surface-900 border border-surface-700/60',
        ghost: 'text-surface-200 hover:bg-surface-800 hover:text-surface-50',
        subtle: 'text-surface-300 hover:bg-surface-850 hover:text-surface-100',
        danger: 'bg-danger-500 text-surface-50 hover:bg-danger-500/90 active:bg-danger-500/80',
        outline:
          'border border-surface-700 bg-transparent text-surface-100 hover:bg-surface-900 hover:text-surface-50',
        link: 'text-accent-400 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 cap-12',
        md: 'h-8 px-3',
        lg: 'h-10 px-4 cap-15',
        icon: 'h-8 w-8',
        'icon-sm': 'h-7 w-7',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        type={asChild ? undefined : type}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { buttonVariants };
