import { ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { trpc } from '@/ipc/trpc';

interface EpicSignInDialogProps {
  /** The Epic sign-in page; null keeps the dialog closed. */
  readonly redirectUrl: string | null;
  readonly onClose: () => void;
  /** Called after the login is saved, with Epic's display name if it sent one. */
  readonly onConnected: (displayName: string | undefined) => void;
}

/**
 * Epic sign-in for the FAB sync.
 *
 * Epic's launcher client has no redirect back into a desktop app: after
 * signing in, the browser shows a JSON page holding a one-time
 * `authorizationCode`. The CLI reads that code from stdin; this is the same
 * step for the app. The user can paste the whole page or just the code; the
 * main process extracts it (`fab.connect`).
 */
export function EpicSignInDialog({ redirectUrl, onClose, onConnected }: EpicSignInDialogProps) {
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = trpc.fab.connect.useMutation({
    onSuccess: (r) => {
      // Cancelled while Epic was answering: the person no longer wants a sync.
      if (redirectUrl == null) return;
      if (r.ok) {
        setPasted('');
        setError(null);
        onConnected(r.displayName);
      } else {
        setError(r.message);
      }
    },
    onError: (e) => setError(e.message),
  });

  const close = () => {
    connect.reset();
    setPasted('');
    setError(null);
    onClose();
  };

  return (
    <Dialog open={redirectUrl != null} onOpenChange={(open) => (open ? null : close())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to Epic</DialogTitle>
          <DialogDescription>
            The FAB sync reads your library with your Epic login. Omnidex keeps it on this computer
            only.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex list-decimal flex-col gap-2 pl-5 cap-12 text-surface-200">
          <li>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (redirectUrl) void window.omnidex?.shell?.openExternal(redirectUrl);
              }}
            >
              <ExternalLink size={12} />
              Open Epic sign-in
            </Button>
          </li>
          <li>Sign in. Epic then shows a short page of text with an "authorizationCode".</li>
          <li>Copy that page (or just the code) and paste it here.</li>
        </ol>

        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pasted.trim()) connect.mutate({ pasted });
          }}
        >
          <Input
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setError(null);
            }}
            placeholder='{"authorizationCode":"…"} or the code'
            aria-label="Epic authorization code"
            aria-invalid={error != null}
            autoFocus
            spellCheck={false}
            className="font-mono cap-12"
          />
          {error ? (
            <p role="alert" className="cap-11 text-danger-300">
              {error}
            </p>
          ) : (
            <p className="cap-11 text-surface-400">
              A code works once and expires after a few minutes.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!pasted.trim() || connect.isPending}
            >
              {connect.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              Connect and sync
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
