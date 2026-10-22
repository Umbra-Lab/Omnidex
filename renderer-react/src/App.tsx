import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TrpcProvider } from './ipc/TrpcProvider';
import { router } from './router';

export function App() {
  return (
    <TrpcProvider>
      <ErrorBoundary>
        {/* reducedMotion="user" makes every JS spring respect the OS
            prefers-reduced-motion setting at the framework level — the
            CSS @media block in global.css only covers plain CSS animation. */}
        <MotionConfig reducedMotion="user">
          <RouterProvider router={router} />
        </MotionConfig>
      </ErrorBoundary>
    </TrpcProvider>
  );
}
