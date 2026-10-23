import { FolderPlus, Heart, ScanSearch, Tag, Trash2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { formatCount } from '@/lib/format';

interface BulkActionBarProps {
  readonly count: number;
  readonly onFavorite: () => void;
  readonly onNewCollection: () => void;
  /**
   * ADDS tags to every selected asset. Never replaces: a replace would delete
   * each asset's existing tags from the same gesture as the benign case, with
   * no undo in the app. The label says "Add tags" so the verb is on screen.
   */
  readonly onAddTags: () => void;
  readonly onRematch?: () => void;
  readonly onRemove: () => void;
  readonly onClear: () => void;
}

/**
 * Floating bulk-action bar. DESIGN.md has specified this since v1 — it could
 * not be built because selection held exactly one asset, so there was never a
 * batch to act on. Every mutation behind these buttons already took an array.
 *
 * Appears on first selection, floating over the content column.
 */
export function BulkActionBar({
  count,
  onFavorite,
  onNewCollection,
  onAddTags,
  onRematch,
  onRemove,
  onClear,
}: BulkActionBarProps) {
  const reduced = useReducedMotion();

  if (count === 0) return null;

  return (
    <motion.div
      // Fly-in from below, gated on prefers-reduced-motion per DESIGN.md.
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.28, ease: [0.32, 0.72, 0.24, 1] }}
      role="toolbar"
      aria-label={`${count} assets selected`}
      // Absolute within the content column, not fixed to the viewport. Centred
      // on the window it drifted over the inspector and covered its action
      // footer — the buttons were visible but unclickable. The bar acts on the
      // grid selection, so it belongs over the grid.
      className="-translate-x-1/2 absolute bottom-4 left-1/2 z-40 flex items-center gap-1 whitespace-nowrap rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-xl shadow-black/60"
    >
      <span className="pr-2 font-mono tabular-nums cap-14 font-semibold text-surface-50">
        {formatCount(count)} selected
      </span>
      <span className="h-6 w-px self-stretch bg-surface-600" />

      <BulkButton icon={<Heart size={14} />} label="Favorite" onClick={onFavorite} />
      <BulkButton icon={<Tag size={14} />} label="Add tags" onClick={onAddTags} />
      <BulkButton
        icon={<FolderPlus size={14} />}
        label="New collection"
        onClick={onNewCollection}
        primary
      />
      {onRematch ? (
        <BulkButton icon={<ScanSearch size={14} />} label="Re-match" onClick={onRematch} />
      ) : null}

      <span className="h-6 w-px self-stretch bg-surface-600" />
      <BulkButton icon={<Trash2 size={14} />} label="Remove" onClick={onRemove} destructive />

      <button
        type="button"
        onClick={onClear}
        className="pl-2 font-mono cap-12 text-surface-400 hover:text-surface-200"
      >
        esc to clear
      </button>
    </motion.div>
  );
}

interface BulkButtonProps {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly destructive?: boolean;
}

function BulkButton({ icon, label, onClick, primary, destructive }: BulkButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex h-8 items-center gap-1.5 rounded-md px-3 cap-14 font-medium transition-colors [transition-duration:var(--duration-micro)]',
        primary
          ? 'bg-accent-500 text-accent-on hover:bg-accent-400'
          : destructive
            ? 'text-danger-300 hover:bg-danger-500/15'
            : 'text-surface-100 hover:bg-surface-700',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}
