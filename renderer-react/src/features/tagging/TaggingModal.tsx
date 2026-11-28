import { Tag, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
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

interface TaggingModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialTags?: ReadonlyArray<string>;
  readonly title?: string;
  readonly description?: string;
  readonly saveLabel?: string;
  /**
   * Require at least one tag before saving. Off by default, because on the
   * single-asset path saving an EMPTY list is how you clear an asset's tags —
   * disabling that would quietly remove a real capability. Additive bulk has
   * nothing to do with zero tags, so it turns this on.
   */
  readonly requireTags?: boolean;
  /**
   * Shown in place of the tag list while the current tags are not known
   * (loading, or failed to load). Editing and saving are off meanwhile: on the
   * replacing single-asset path, saving an unknown set would wipe real tags.
   */
  readonly loadingMessage?: string;
  readonly onSave: (tags: ReadonlyArray<string>) => void;
}

export function TaggingModal({
  open,
  onOpenChange,
  initialTags = [],
  title = 'Manage tags',
  description = 'Press Enter to add. Saving replaces this asset’s tags.',
  saveLabel = 'Save',
  requireTags = false,
  loadingMessage,
  onSave,
}: TaggingModalProps) {
  const [tags, setTags] = useState<ReadonlyArray<string>>(initialTags);
  const [draft, setDraft] = useState('');

  const blocked = loadingMessage != null;
  // When loading finishes, seed the draft from the tags that just arrived.
  // Adjusted during render rather than by remounting, so the dialog itself
  // (its open animation and focus trap) is not torn down and replayed.
  const [wasBlocked, setWasBlocked] = useState(blocked);
  if (blocked !== wasBlocked) {
    setWasBlocked(blocked);
    if (!blocked) setTags(initialTags);
  }

  const add = () => {
    if (blocked) return;
    const next = draft.trim();
    if (!next) return;
    if (tags.includes(next)) return;
    setTags([...tags, next]);
    setDraft('');
  };

  const remove = (t: string) => setTags(tags.filter((x) => x !== t));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            disabled={blocked}
            aria-label="Add a tag"
            placeholder="Add a tag…"
          />
          <Button variant="secondary" onClick={add} disabled={blocked}>
            <Tag size={12} />
            Add
          </Button>
        </div>

        <div className="flex min-h-[4rem] flex-wrap gap-1.5">
          {blocked ? (
            <span className="cap-12 text-surface-400">{loadingMessage}</span>
          ) : tags.length === 0 ? (
            <span className="cap-12 text-surface-400">No tags yet.</span>
          ) : (
            tags.map((t) => (
              <Badge key={t} variant="default" className="pr-0">
                <span>{t}</span>
                <button
                  type="button"
                  onClick={() => remove(t)}
                  // Icon stays small, but the hit target is ≥24×24px (WCAG 2.5.8).
                  className="-my-1 -mr-1 flex h-6 w-6 items-center justify-center rounded-sm text-surface-400 transition-colors hover:bg-surface-700 hover:text-surface-100"
                  aria-label={`Remove ${t}`}
                >
                  <X size={10} />
                </button>
              </Badge>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={blocked || (requireTags && tags.length === 0)}
            onClick={() => {
              onSave(tags);
              onOpenChange(false);
            }}
          >
            {saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
