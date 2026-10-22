import { X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/components/ui/toaster';
import { useUpdateActions, useUpdateState, useUpdateSync } from './useUpdates';
import { ACTION_LABEL, actionsFor, bannerKey, bannerText, showsBanner } from './view';

/**
 * App-wide strip for an update that needs a decision: one was found, one is
 * downloading, one is ready, or a download failed. It sits under the nav bar
 * and only exists in those phases, so it costs no space the rest of the time.
 * A failed *check* is deliberately absent: nobody asked the banner, and a
 * background check that could not reach GitHub is not worth interrupting for.
 *
 * Owns the one listener for pushed update state (`useUpdateSync`).
 *
 * "Later" only dismisses the banner. The update stays downloaded and installs
 * when the app quits (`autoInstallOnAppQuit` in updater.ts), and Settings →
 * About keeps offering "Restart now".
 */
export function UpdateBanner() {
  useUpdateSync();
  const state = useUpdateState();
  const actions = useUpdateActions();
  const [dismissed, setDismissed] = useState<string | null>(null);

  if (!state?.supported) return null;
  const { status } = state;
  if (!showsBanner(status) || dismissed === bannerKey(status)) return null;

  const dismiss = () => setDismissed(bannerKey(status));
  const later = () => {
    dismiss();
    toast('The update installs when you quit Omnidex');
  };

  const buttons = actionsFor(status);

  return (
    <output className="flex shrink-0 items-center gap-3 border-b border-surface-800/60 bg-surface-850 px-4 py-1.5 cap-12 text-surface-200">
      <span className="min-w-0 truncate">{bannerText(status)}</span>

      {status.phase === 'downloading' ? (
        <>
          <Progress
            value={status.percent}
            aria-label="Download progress"
            className="w-40 shrink-0"
          />
          <span className="shrink-0 font-mono tabular-nums text-surface-300">
            {status.percent}%
          </span>
        </>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {buttons.map((action, i) => (
          <Button
            key={action}
            size="sm"
            variant={i === 0 ? 'primary' : 'ghost'}
            disabled={
              (action === 'download' || action === 'retry-download') && actions.pending.download
            }
            onClick={() => actions.run(action)}
          >
            {action === 'install' && actions.pending.install ? 'Restarting…' : ACTION_LABEL[action]}
          </Button>
        ))}
        {status.phase === 'downloaded' ? (
          <Button size="sm" variant="ghost" onClick={later}>
            Later
          </Button>
        ) : null}
        {status.phase !== 'downloading' && status.phase !== 'downloaded' ? (
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={dismiss}>
            <X />
          </Button>
        ) : null}
      </div>
    </output>
  );
}
