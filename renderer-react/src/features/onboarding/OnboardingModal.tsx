import { Boxes, FolderPlus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toaster';
import { EditLocationModal } from '@/features/locations/EditLocationModal';
import { trpc } from '@/ipc/trpc';

const STORAGE_KEY = 'omnidex.onboarded.v1';

export function OnboardingModal() {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const locations = trpc.scanLocations.list.useQuery();
  const utils = trpc.useUtils();

  // After the very first folder is added, kick off its scan so "Add first
  // folder" actually indexes something — the ScanProgressPanel surfaces it.
  const refreshOne = trpc.scanner.refreshOne.useMutation({
    onSuccess: () => {
      utils.assets.invalidate();
      utils.scanLocations.list.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    if (locations.isPending) return;
    if ((locations.data?.length ?? 0) === 0) setOpen(true);
  }, [locations.data, locations.isPending]);

  const dismiss = () => {
    window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    setOpen(false);
  };

  return (
    <>
      <EditLocationModal
        open={addOpen}
        onSaved={(id) => {
          toast.success('Scanning your first folder…');
          refreshOne.mutate(id);
        }}
        onOpenChange={(next) => {
          setAddOpen(next);
          if (!next) dismiss();
        }}
      />
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(v) : dismiss())}>
        <DialogContent>
          <DialogHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-accent-500/15 text-accent-400">
              <Sparkles size={22} strokeWidth={1.6} />
            </div>
            <DialogTitle className="text-center">Welcome to Omnidex</DialogTitle>
            <DialogDescription className="text-center">
              Register the folders where your Unreal packs and assets live. Omnidex scans them right
              away; marketplace enrichment is a manual step you can run later.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Feature
              icon={FolderPlus}
              title="Register a folder"
              description="Saves the location and scans it now."
            />
            <Feature
              icon={Boxes}
              title="Enrich later"
              description="Pull Orbital + FAB metadata on demand."
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={dismiss}>
              Later
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <FolderPlus size={12} />
              Add first folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Feature({
  icon: Icon,
  title,
  description,
}: {
  readonly icon: typeof Boxes;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-surface-800/60 bg-surface-900/40 p-3">
      <Icon size={14} className="text-accent-400" />
      <span className="font-display cap-12 font-semibold text-surface-100">{title}</span>
      <span className="cap-11 text-surface-400">{description}</span>
    </div>
  );
}
