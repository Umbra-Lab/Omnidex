import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useCallback } from 'react';
import { CommandPalette } from '@/components/CommandPalette';
import { NavBar } from '@/components/layout/NavBar';
import { StatusBar } from '@/components/layout/StatusBar';
import { ModalHost } from '@/components/ModalHost';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { OnboardingModal } from '@/features/onboarding/OnboardingModal';
import { ScanProgressPanel } from '@/features/scanning/ScanProgressPanel';
import { UpdateBanner } from '@/features/updates/UpdateBanner';
import { useIpcEvent } from '@/hooks/useIpcEvent';
import { useViewTransitions } from '@/hooks/useViewTransitions';
import { useUiStore } from '@/stores/ui';
import { isSettingsTab } from '@/views/SettingsView';

interface AppShellProps {
  readonly children: ReactNode;
}

/**
 * Persistent chrome around every route: nav bar, update banner, command
 * palette, toaster, settings modal, status bar.
 *
 * Window controls come from the OS. A custom TitleBar used to render on top of
 * the native frame, which produced two visible chrome strips; it was removed
 * and then sat unimported for months, so it is now deleted rather than
 * "preserved for a future frameless pass" — git remembers it if that pass ever
 * happens.
 */
export function AppShell({ children }: AppShellProps) {
  const setPalette = useUiStore((s) => s.setPalette);
  const navigate = useNavigate();
  useViewTransitions();
  useIpcEvent<void>(
    'omnidex:palette:open',
    useCallback(() => setPalette(true), [setPalette]),
  );
  // Native menu items that belong to a settings tab (Check for Updates…) send
  // the tab name; an unknown one is ignored rather than routed to a dead URL.
  useIpcEvent<string>(
    'omnidex:settings:open',
    useCallback(
      (tab) => {
        if (isSettingsTab(tab)) void navigate({ to: '/settings/$tab', params: { tab } });
      },
      [navigate],
    ),
  );

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-screen flex-col overflow-hidden">
        <a
          href="#main"
          className="sr-only z-50 rounded-sm bg-surface-800 px-3 py-2 cap-14 text-surface-50 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        <NavBar />
        <UpdateBanner />
        <main id="main" className="flex flex-1 overflow-hidden">
          {children}
        </main>
        <StatusBar />
        <CommandPalette />
        <OnboardingModal />
        <ScanProgressPanel />
        <ModalHost />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
