import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';

/**
 * Settings → AI: which brain answers "Ask this course", and with how much
 * context. Local-first by design — the default configuration costs nothing and
 * sends nothing off the machine. Claude Code appears only where the CLI is
 * actually installed; there is deliberately no API-key field in v1.
 */

const KEYS = {
  provider: 'ask.provider',
  localBaseUrl: 'ask.local_base_url',
  localModel: 'ask.local_model',
  contextBudget: 'ask.context_budget',
} as const;

export function AiTab() {
  const utils = trpc.useUtils();
  const status = trpc.ask.status.useQuery();
  const setSetting = trpc.settings.set.useMutation();

  const [provider, setProvider] = useState<'local' | 'claude-code'>('local');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!status.data || loaded) return;
    setProvider(status.data.provider);
    setBaseUrl(status.data.localBaseUrl);
    setModel(status.data.localModel);
    setBudget(String(status.data.contextBudget));
    setLoaded(true);
  }, [status.data, loaded]);

  const save = async () => {
    const entries: [string, string][] = [
      [KEYS.provider, provider],
      [KEYS.localBaseUrl, baseUrl.trim()],
      [KEYS.localModel, model.trim()],
      [KEYS.contextBudget, budget.trim()],
    ];
    try {
      for (const [key, value] of entries) {
        await setSetting.mutateAsync({ key, value, setting_type: 'string' });
      }
      await utils.ask.status.invalidate();
      toast.success('Ask settings saved');
    } catch (e) {
      toast.error(`Could not save settings: ${(e as Error).message}`);
    }
  };

  const ccAvailable = status.data?.claudeCodeAvailable ?? false;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Ask provider</CardTitle>
          <CardDescription>
            Who answers "Ask this course". Both options are free: Local runs on your llama-swap
            stack, Claude Code uses your existing subscription login.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-4 px-6 pb-5">
          <div className="flex gap-2">
            {(
              [
                ['local', 'Local (llama-swap)'],
                ['claude-code', 'Claude Code'],
              ] as const
            ).map(([value, label]) => {
              const disabled = value === 'claude-code' && !ccAvailable;
              return (
                <button
                  key={value}
                  type="button"
                  disabled={disabled}
                  onClick={() => setProvider(value)}
                  className={cn(
                    'rounded-sm border px-3 py-1.5 cap-12 transition-colors',
                    provider === value
                      ? 'border-accent-500/60 bg-accent-500/10 text-surface-50'
                      : 'border-surface-700 text-surface-300 hover:border-surface-600',
                    disabled && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {!ccAvailable ? (
            <p className="cap-11 text-surface-500">
              Claude Code was not found on this machine, so that option is unavailable.
            </p>
          ) : null}

          <div className="flex items-center justify-between border-t border-surface-800/60 pt-3">
            <div>
              <Label htmlFor="ask-base-url">Local server URL</Label>
              <p className="cap-11 text-surface-400">OpenAI-compatible endpoint of llama-swap.</p>
            </div>
            <Input
              id="ask-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="w-64"
              placeholder="http://localhost:8080/v1"
            />
          </div>

          <div className="flex items-center justify-between border-t border-surface-800/60 pt-3">
            <div>
              <Label htmlFor="ask-model">Local model</Label>
              <p className="cap-11 text-surface-400">Model name as llama-swap knows it.</p>
            </div>
            <Input
              id="ask-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-64"
              placeholder="qwen3.6"
            />
          </div>

          <div className="flex items-center justify-between border-t border-surface-800/60 pt-3">
            <div>
              <Label htmlFor="ask-budget">Context budget (tokens)</Label>
              <p className="cap-11 text-surface-400">
                Courses over this get a question-scoped subset instead of the whole transcript.
              </p>
            </div>
            <Input
              id="ask-budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="w-64 font-mono tabular-nums"
              placeholder="120000"
            />
          </div>

          <div className="flex justify-end border-t border-surface-800/60 pt-3">
            <Button variant="primary" size="sm" onClick={() => void save()} disabled={setSetting.isPending}>
              {setSetting.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
