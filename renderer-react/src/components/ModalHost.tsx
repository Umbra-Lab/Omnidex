import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { buttonVariants } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { AddToCollectionDialog } from '@/features/collections/AddToCollectionDialog';
import { TaggingModal } from '@/features/tagging/TaggingModal';
import { trpc } from '@/ipc/trpc';
import { cn } from '@/lib/cn';
import { useModals } from '@/stores/modals';

/**
 * Mounts every shared modal exactly once, driven by `useModals`. Lives next to
 * `ScanProgressPanel` in `AppShell` so any feature can open a modal by calling
 * a `useModals()` setter — no cluster imports another cluster's component.
 */
export function ModalHost() {
  return (
    <>
      <TaggingHost />
      <BulkTaggingHost />
      <AddToCollectionDialog />
      <ConfirmHost />
    </>
  );
}

/**
 * Host-fetches variant: fetches the target asset's current tags via
 * `trpc.assets.getTags` and seeds the presentational `TaggingModal`. On save it
 * persists with `assets.setTags` and invalidates the asset queries so cards,
 * `get`, and search reflect the new tags.
 */
function TaggingHost() {
  const tagging = useModals((s) => s.tagging);
  const close = useModals((s) => s.closeTagging);
  const assetId = tagging?.assetId ?? null;

  const utils = trpc.useUtils();
  const tagsQuery = trpc.assets.getTags.useQuery(assetId ?? 0, { enabled: assetId != null });
  const setTags = trpc.assets.setTags.useMutation({
    onSuccess: () => {
      void utils.assets.invalidate();
    },
    onError: (err) => {
      toast.error(`Couldn't save tags: ${err.message}`);
    },
  });

  if (assetId == null) return null;

  return (
    <TaggingModal
      // Remount per-asset so the modal's internal draft state resets and picks
      // up freshly-fetched initialTags.
      key={assetId}
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      initialTags={tagsQuery.data ?? []}
      onSave={(tags) => {
        setTags.mutate({ assetId, tags: [...tags] });
      }}
    />
  );
}

/**
 * Single mounted confirmation alert. Renders the alert-dialog primitives
 * directly (rather than the fixed-variant `ConfirmationAlert`) so the
 * `destructive` flag can swap the action button to the danger variant. Awaits
 * a possibly-async `onConfirm`, surfacing failures as a toast.
 */
function ConfirmHost() {
  const confirm = useModals((s) => s.confirm);
  const close = useModals((s) => s.closeConfirm);
  const [busy, setBusy] = useState(false);

  const open = confirm != null;

  const run = async () => {
    if (!confirm) return;
    try {
      setBusy(true);
      await confirm.onConfirm();
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <AlertDialogContent>
        {confirm ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>
                {confirm.cancelLabel ?? 'Cancel'}
              </AlertDialogCancel>
              <AlertDialogAction
                // Radix closes on click by default; prevent it so the dialog
                // stays up while an async onConfirm runs, then close in `run`.
                onClick={(e) => {
                  e.preventDefault();
                  void run();
                }}
                disabled={busy}
                className={cn(
                  confirm.destructive && buttonVariants({ variant: 'danger', size: 'md' }),
                )}
              >
                {busy ? 'Working…' : (confirm.confirmLabel ?? 'Confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Bulk tagging. Separate host from TaggingHost because the operations differ:
 * that one REPLACES one asset’s tag set, this one ADDS a delta to many. The
 * modal opens empty and the button says "Add tags", so the verb is on screen
 * rather than implied — there is no undo, and a control that could wipe the
 * curation on forty packs should not look like the one that adds a word.
 */
function BulkTaggingHost() {
  const bulk = useModals((s) => s.bulkTagging);
  const close = useModals((s) => s.closeBulkTagging);
  const utils = trpc.useUtils();

  const addTags = trpc.assets.addTags.useMutation({
    onSuccess: (n) => {
      void utils.assets.invalidate();
      toast.success(`Tagged ${n} ${n === 1 ? 'asset' : 'assets'}`);
    },
    onError: (err) => toast.error(`Couldn't add tags: ${err.message}`),
  });

  const ids = bulk?.assetIds ?? null;
  if (ids == null || ids.length === 0) return null;

  return (
    <TaggingModal
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      initialTags={[]}
      title={`Add tags to ${ids.length} ${ids.length === 1 ? 'asset' : 'assets'}`}
      description="Press Enter to add. These are added to each selected asset; existing tags are kept."
      saveLabel="Add tags"
      requireTags
      onSave={(tags) => addTags.mutate({ ids, tags: [...tags] })}
    />
  );
}
