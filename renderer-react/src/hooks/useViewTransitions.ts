import { useEffect } from 'react';
import { router } from '@/router';

/**
 * Hook into TanStack Router navigation and wrap state updates in
 * `document.startViewTransition` so the View Transitions API cross-fades
 * matching `view-transition-name` elements (AssetCard → InspectorPanel
 * hero is the headline case).
 *
 * Falls back to a no-op when the browser doesn't support the API.
 */
export function useViewTransitions(): void {
  useEffect(() => {
    const start = (
      document as Document & {
        startViewTransition?: (cb: () => void) => unknown;
      }
    ).startViewTransition;
    if (!start) return;

    const unsubscribe = router.subscribe('onBeforeNavigate', ({ toLocation }) => {
      if (toLocation.pathname === router.state.location.pathname) return;
      start.call(document, () => {
        // Route commit happens synchronously after onBeforeNavigate, so
        // wrapping this empty callback captures the before/after states.
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);
}
