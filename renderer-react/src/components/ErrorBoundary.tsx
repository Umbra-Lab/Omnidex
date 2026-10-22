import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * App-level React error boundary. Wraps the routed content in `App.tsx` so a
 * render-time throw shows a recoverable fallback instead of a blank window.
 *
 * Renderer-only: it can't catch errors outside React's render path (those are
 * surfaced by the global query `onError` toast and the main-process logs). The
 * Reload button does a hard `window.location.reload()`, which is the cheapest
 * reliable recovery in an Electron renderer.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surfaced to the renderer devtools console; the main process tails this.
    console.error('[ErrorBoundary] render error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-surface-950 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-danger-500/10 text-danger-400">
          <AlertTriangle size={22} />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="font-display cap-18 font-semibold text-surface-50">
            Something went wrong
          </h1>
          <p className="max-w-md cap-14 text-surface-400">
            The interface hit an unexpected error. Reloading usually clears it — your library is
            unaffected.
          </p>
        </div>
        <pre className="max-w-md overflow-auto rounded-sm border border-surface-800/60 bg-surface-900 px-3 py-2 text-left font-mono cap-11 text-surface-400">
          {error.message}
        </pre>
        <Button variant="primary" size="md" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
