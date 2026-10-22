import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useUpdateActions, useUpdateState } from './useUpdates';
import { ACTION_LABEL, actionsFor, isBusy, statusText } from './view';

const RELEASES_HOST = 'github.com/Umbra-Lab/Omnidex';

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/**
 * Settings → About → Software updates.
 *
 * The card states what each control does to the network, because that is the
 * point of the opt-in: "Check for updates" makes one request now, the switch
 * makes one at launch and every 4 hours, and neither downloads anything. The
 * exact request list is in PRIVACY.md (section 3); change both together.
 */
export function UpdatesCard() {
  const state = useUpdateState();
  const actions = useUpdateActions();

  const supported = state?.supported ?? false;
  const status = state?.status;
  const checking = status?.phase === 'checking' || actions.pending.check;
  const buttons = status ? actionsFor(status) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Software updates</CardTitle>
        <CardDescription>
          Omnidex checks GitHub for a newer release only when you ask, or on a schedule if you turn
          that on.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4 px-6 pb-5">
        <div className="flex items-center justify-between">
          <Label>Installed version</Label>
          <span className="font-mono tabular-nums cap-12 text-surface-200">
            {state?.currentVersion ?? '—'}
          </span>
        </div>

        <div className="flex items-center justify-between gap-6 border-t border-surface-800/60 pt-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="update-auto-check">Check automatically</Label>
            <p className="cap-11 text-surface-400">
              Off by default. When on, Omnidex checks at launch and every 4 hours, and once as soon
              as you turn it on.
            </p>
          </div>
          <Switch
            id="update-auto-check"
            checked={state?.autoCheck ?? false}
            disabled={!state || actions.pending.setAutoCheck}
            onCheckedChange={actions.setAutoCheck}
            aria-label="Check for updates automatically"
          />
        </div>

        <div className="flex flex-col gap-3 border-t border-surface-800/60 pt-3">
          <div className="flex items-center justify-between gap-6">
            <output className="block min-w-0 cap-12 text-surface-300">
              {state ? statusText(state, formatTime) : 'Loading…'}
            </output>
            <Button
              size="sm"
              disabled={!supported || checking || (status ? isBusy(status) : false)}
              onClick={actions.check}
            >
              {checking ? (
                <>
                  <Loader2 className="animate-spin" />
                  Checking…
                </>
              ) : (
                'Check for updates'
              )}
            </Button>
          </div>

          {status?.phase === 'downloading' ? (
            <div className="flex items-center gap-3">
              <Progress value={status.percent} aria-label="Download progress" />
              <span className="shrink-0 font-mono tabular-nums cap-12 text-surface-300">
                {status.percent}%
              </span>
            </div>
          ) : null}

          {buttons.length > 0 ? (
            <div className="flex items-center gap-2">
              {buttons.map((action, i) => (
                <Button
                  key={action}
                  size="sm"
                  variant={i === 0 ? 'primary' : 'secondary'}
                  disabled={
                    (action === 'download' || action === 'retry-download') &&
                    actions.pending.download
                  }
                  onClick={() => actions.run(action)}
                >
                  {action === 'install' && actions.pending.install
                    ? 'Restarting…'
                    : ACTION_LABEL[action]}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-1 border-t border-surface-800/60 pt-3 cap-11 text-surface-400">
          <p>
            A check requests the release list and update manifest from{' '}
            <span className="font-mono">{RELEASES_HOST}</span>. It sends your IP address and a
            user-agent naming Omnidex, its version and your operating system. It sends nothing about
            your library, and nothing downloads until you choose Download update.
          </p>
          <p>
            Installing an update on macOS needs a build signed with an Apple Developer ID. Without
            one the download fails; use View release to install by hand.
          </p>
        </div>
      </div>
    </Card>
  );
}
