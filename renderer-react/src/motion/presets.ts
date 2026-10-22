import type { Transition, Variants } from 'motion/react';

/**
 * Motion presets per FRONTEND-VISION.md.
 *
 * Three-speed scale:
 *   - micro  120ms: hover, press
 *   - macro  280ms: panel, modal
 *   - page   380ms: route
 *
 * Physics-based springs (stiffness 280, damping 30) — never linear eases.
 * `prefers-reduced-motion` is honored globally by the <MotionConfig
 * reducedMotion="user"> wrapper in App.tsx, so presets don't self-gate.
 */

export const uiSpring: Transition = {
  type: 'spring',
  stiffness: 280,
  damping: 30,
  mass: 0.9,
};

export const panelSpring: Transition = {
  type: 'spring',
  stiffness: 220,
  damping: 32,
  mass: 1,
};

export const pageTransition: Transition = {
  type: 'spring',
  stiffness: 200,
  damping: 26,
  mass: 1,
};

export const modalEnter: Variants = {
  initial: { opacity: 0, scale: 0.96, y: 4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: -4 },
};

export const fadeInOut: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
};

export const stagger = (delay = 0.04): Transition => ({
  staggerChildren: delay,
  delayChildren: 0.02,
});

/**
 * Shared-element layout transition for card → inspector zoom.
 * Pair with `layoutId` on the AssetCard and InspectorPanel hero image.
 */
export const sharedElement: Transition = {
  type: 'spring',
  stiffness: 320,
  damping: 32,
  mass: 0.85,
};
