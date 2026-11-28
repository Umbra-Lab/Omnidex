import { FolderPlus, Heart, ScanSearch, Tag, Trash2, X } from 'lucide-react';
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
 *
 * The column is a size container (`@container` on the parent). When it is
 * narrower than the bar's full width, typically with the inspector open on a
 * small window, the buttons drop to icons with their names as tooltips rather
 * than wrapping each label onto two or three lines.
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
      // grid selection, so it belongs over the grid. `w-max` because an
      // absolute box at left-1/2 otherwise shrinks to the half-column to its
      // right and wraps every label.
      className="-translate-x-1/2 absolute bottom-4 left-1/2 z-40 flex w-max max-w-[calc(100%-2rem)] items-center gap-1 rounded-lg border border-surface-700 bg-surface-800 px-3 py-2 shadow-xl shadow-black/60"
    >
      {/* Under 24rem the word "selected" goes, so a four-digit count still
          fits beside the icons; the toolbar's label keeps the full phrase. */}
      <span className="min-w-0 truncate whitespace-nowrap pr-2 font-mono tabular-nums cap-14 font-semibold text-surface-50">
        {formatCount(count)}
        <span className="hidden @[24rem]:inline"> selected</span>
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
        title="Clear selection (Esc)"
        className="flex shrink-0 items-center whitespace-nowrap pl-2 font-mono cap-12 text-surface-400 hover:text-surface-200"
      >
        {/* No aria-label: when "esc to clear" shows it must stay the accessible
            name (WCAG 2.5.3, label in name), so the icon mode gets sr-only text. */}
        <span className="hidden @2xl:inline">esc to clear</span>
        <span className="sr-only @2xl:hidden">Clear selection</span>
        <X size={14} className="@2xl:hidden" aria-hidden />
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
      aria-label={label}
      title={label}
      className={[
        'flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 @2xl:px-3 cap-14 font-medium transition-colors [transition-duration:var(--duration-micro)]',
        primary
          ? 'bg-accent-500 text-accent-on hover:bg-accent-400'
          : destructive
            ? 'text-danger-300 hover:bg-danger-500/15'
            : 'text-surface-100 hover:bg-surface-700',
      ].join(' ')}
    >
      {icon}
      <span className="hidden @2xl:inline">{label}</span>
    </button>
  );
}
