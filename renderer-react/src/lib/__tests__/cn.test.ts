import { describe, expect, it } from 'vitest';
import { cn } from '../cn';

describe('cn', () => {
  it('joins plain class names', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy values from conditional expressions', () => {
    const active = false;
    const open = true;
    expect(cn('base', active && 'is-active', open && 'is-open')).toBe('base is-open');
  });

  it('lets a later Tailwind class win a conflicting utility (twMerge)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm text-red-500', 'text-lg')).toBe('text-red-500 text-lg');
  });

  it('lets a later cap-N type size replace an earlier one', () => {
    // The bug: both survived, and the stylesheet's ascending order made the
    // larger size win, so a component's `cap-12` override rendered at 14px.
    expect(cn('px-2.5 cap-14 text-surface-100', 'cap-12')).toBe('px-2.5 text-surface-100 cap-12');
    expect(cn('cap-12-prose', 'cap-14')).toBe('cap-14');
    expect(cn('cap-14', 'cap-11-prose')).toBe('cap-11-prose');
  });

  it('keeps colours and unrelated classes next to a cap-N size', () => {
    expect(cn('cap-14 text-surface-100 font-mono', 'cap-10')).toBe(
      'text-surface-100 font-mono cap-10',
    );
  });

  it('lets a cap-N size replace an earlier Tailwind font size', () => {
    expect(cn('text-sm leading-6', 'cap-12')).toBe('cap-12');
  });

  it('accepts arrays and object syntax from clsx', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });
});
