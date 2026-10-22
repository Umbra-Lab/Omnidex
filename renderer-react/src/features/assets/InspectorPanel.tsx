import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Folder,
  FolderPlus,
  Heart,
  Image as ImageIcon,
  Star,
  Tag,
  Wand2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/ipc/trpc';
import { resolveThumbnail } from '@/lib/assetUrl';
import {
  formatBytes,
  formatCount,
  formatRating,
  formatSupportedVersions,
  formatTaxonomyLabel,
} from '@/lib/format';
import { panelSpring } from '@/motion/presets';
import { useModals } from '@/stores/modals';
import { INSPECTOR_MAX_WIDTH, INSPECTOR_MIN_WIDTH, useUiStore } from '@/stores/ui';
import { MatchPickerModal } from './MatchPickerModal';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  // YYYY-MM-DD prefix is enough for both ISO timestamps and SQLite TEXT dates.
  return iso.slice(0, 10);
}

function parseGallery(asset: {
  orbital_gallery_images: string | null;
  orbital_thumbnail_url: string | null;
  thumbnail_path: string | null;
}): string[] {
  const out: string[] = [];
  const local = resolveThumbnail(asset);
  if (local) out.push(local);
  if (asset.orbital_gallery_images) {
    try {
      const parsed = JSON.parse(asset.orbital_gallery_images) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && !out.includes(item)) out.push(item);
          else if (
            item &&
            typeof item === 'object' &&
            'url' in item &&
            typeof (item as { url: unknown }).url === 'string'
          ) {
            const url = (item as { url: string }).url;
            if (!out.includes(url)) out.push(url);
          }
        }
      }
    } catch {
      // ignore malformed JSON
    }
  }
  if (asset.orbital_thumbnail_url && !out.includes(asset.orbital_thumbnail_url)) {
    out.push(asset.orbital_thumbnail_url);
  }
  return out;
}

interface InspectorPanelProps {
  readonly assetId: number | null;
  readonly onClose: () => void;
}

export function InspectorPanel({ assetId, onClose }: InspectorPanelProps) {
  const open = assetId != null;
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);

  // Pointer-driven splitter on the panel's left edge. Drag to resize; the
  // store clamps to [INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH] and persists
  // to localStorage. We also cap to half the viewport so the panel can't
  // squeeze the grid into oblivion on smaller windows.
  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = inspectorWidth;
      const viewportCap = Math.min(INSPECTOR_MAX_WIDTH, window.innerWidth * 0.6);
      const onMove = (e: PointerEvent) => {
        // Panel is on the right — moving cursor LEFT increases width.
        const delta = startX - e.clientX;
        const next = Math.max(INSPECTOR_MIN_WIDTH, Math.min(viewportCap, startWidth + delta));
        setInspectorWidth(next);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [inspectorWidth, setInspectorWidth],
  );

  // Keyboard resize applies the same clamp as the pointer drag — including the
  // 60%-of-viewport cap — so Arrow/Home/End can't push the panel past what a
  // drag could reach.
  const onResizeTo = useCallback(
    (next: number) => {
      const viewportCap = Math.min(INSPECTOR_MAX_WIDTH, window.innerWidth * 0.6);
      setInspectorWidth(Math.max(INSPECTOR_MIN_WIDTH, Math.min(viewportCap, next)));
    },
    [setInspectorWidth],
  );

  // If the viewport shrinks below the saved width × 2, auto-trim the
  // inspector so the asset grid retains at least half the window.
  useEffect(() => {
    function fit() {
      const cap = Math.max(INSPECTOR_MIN_WIDTH, Math.floor(window.innerWidth * 0.6));
      if (inspectorWidth > cap) setInspectorWidth(cap);
    }
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [inspectorWidth, setInspectorWidth]);

  // Esc closes the inspector when one is open. Skip when focus is in an
  // input so the user can clear text fields without dismissing the panel.
  // Capture phase on window so we beat anything calling stopPropagation.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  return (
    <AnimatePresence mode="wait">
      {open ? (
        <motion.aside
          key="inspector"
          initial={{ x: inspectorWidth, opacity: 0.6 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: inspectorWidth, opacity: 0 }}
          transition={panelSpring}
          // `flex-basis` (via `width`) sets the preferred width; `flex-shrink:
          // 1` (default — no `shrink-0` here) lets the panel give back some
          // pixels when the grid wants more columns than the viewport can fit.
          // `minWidth` keeps it usable; `maxWidth: 60vw` prevents it from
          // dominating on smaller windows. This stops the panel from being
          // clipped by the parent's overflow-hidden when sidebar + grid +
          // inspector exceed viewport.
          data-testid="inspector"
          style={{
            width: inspectorWidth,
            minWidth: INSPECTOR_MIN_WIDTH,
            maxWidth: '60vw',
          }}
          className="relative flex h-full flex-col overflow-hidden border-l border-surface-800/60 bg-surface-950"
        >
          <ResizeHandle
            onPointerDown={onResizeStart}
            width={inspectorWidth}
            min={INSPECTOR_MIN_WIDTH}
            max={INSPECTOR_MAX_WIDTH}
            onResizeTo={onResizeTo}
          />
          <InspectorContent assetId={assetId} onClose={onClose} />
        </motion.aside>
      ) : (
        <motion.aside
          key="empty"
          style={{ width: Math.max(INSPECTOR_MIN_WIDTH, inspectorWidth - 80) }}
          className="hidden h-full shrink-0 flex-col overflow-y-auto border-l border-surface-800/60 bg-surface-950/60 xl:flex"
        >
          <LibraryHealthAside />
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

// Keyboard resize step (px per Arrow press) — a comfortable nudge that still
// reaches both ends of the 360–720 range in a few presses.
const RESIZE_STEP = 24;

function ResizeHandle({
  onPointerDown,
  width,
  min,
  max,
  onResizeTo,
}: {
  readonly onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  readonly onResizeTo: (next: number) => void;
}) {
  // Accessible window splitter (WAI-ARIA). The inspector is the RIGHT pane, so
  // — mirroring the pointer drag (cursor left = wider) — ArrowLeft widens and
  // ArrowRight narrows. Home jumps to the widest allowed width, End to the
  // narrowest. onResizeTo re-clamps to the live viewport cap.
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = width + RESIZE_STEP;
        break;
      case 'ArrowRight':
        next = width - RESIZE_STEP;
        break;
      case 'Home':
        next = max;
        break;
      case 'End':
        next = min;
        break;
      default:
        return;
    }
    event.preventDefault();
    onResizeTo(next);
  }

  return (
    // Fragment lets the biome-ignore JSX comment attach to the splitter node.
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window-splitter pattern is a focusable role="separator"; <hr> can't be an interactive, value-bearing resizer */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector panel"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="group absolute -left-1 top-0 z-10 flex h-full w-2 cursor-col-resize items-center justify-center outline-none focus-visible:bg-accent-500/20"
      >
        <span className="h-full w-px bg-transparent transition-colors group-hover:bg-accent-500/60 group-focus-visible:bg-accent-500/80" />
      </div>
    </>
  );
}

function InspectorContent({
  assetId,
  onClose,
}: {
  readonly assetId: number;
  readonly onClose: () => void;
}) {
  const query = trpc.assets.get.useQuery(assetId);
  const asset = query.data;
  const utils = trpc.useUtils();
  const openTagging = useModals((s) => s.openTagging);
  const openAddToCollection = useModals((s) => s.openAddToCollection);
  const [matchOpen, setMatchOpen] = useState(false);

  const setFavorite = trpc.assets.setFavorite.useMutation({
    onSuccess: () => {
      void utils.assets.get.invalidate(assetId);
      void utils.assets.listCards.invalidate();
    },
  });

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (query.isError || !asset) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-surface-400">
        <X size={18} />
        <p className="cap-12">Asset unavailable.</p>
      </div>
    );
  }

  const title = asset.orbital_title ?? asset.name;
  const hasMatch = asset.orbital_title != null || asset.matched_orbital_product_slug != null;

  return (
    <>
      <MatchPickerModal
        assetId={assetId}
        assetName={asset.name}
        currentSlug={asset.matched_orbital_product_slug}
        open={matchOpen}
        onOpenChange={setMatchOpen}
      />
      <header className="flex items-center justify-between border-b border-surface-800/60 px-4 py-2.5">
        <span className="font-mono cap-10 uppercase tracking-[0.18em] text-surface-400">
          Inspector
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close inspector"
          className="flex h-6 w-6 items-center justify-center rounded-sm text-surface-400 transition-colors hover:bg-surface-900 hover:text-surface-100"
        >
          <X size={14} />
        </button>
      </header>
      {/*
        Native scroll container — Radix's ScrollArea wraps children in a
        <div style="display: table; min-width: 100%"> which sizes to widest
        content rather than parent width. That made any single wide element
        (a long URL, a date, a paragraph without spaces) push the entire
        inspector body wider than the panel, clipping every line at the same
        horizontal point. Native overflow handling fixes it for good.
      */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex min-w-0 flex-col gap-4 p-5">
          <Gallery asset={asset} />

          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-display cap-18 font-semibold tracking-tight text-surface-50 break-words">
              {title}
            </h2>
            {asset.orbital_seller_name ? (
              <p className="font-mono cap-11 text-surface-400 break-words">
                by {asset.orbital_seller_name}
              </p>
            ) : null}
            <div className="mt-1 flex flex-wrap gap-1.5">
              {asset.fab_owned ? <Badge variant="accent">FAB owned</Badge> : null}
              {asset.is_favorite ? (
                <Badge variant="default">
                  <Star size={11} className="fill-current" />
                  Favorite
                </Badge>
              ) : null}
              {asset.asset_type ? <Badge variant="outline">{asset.asset_type}</Badge> : null}
            </div>
          </div>

          <Tabs defaultValue="details" className="min-w-0">
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="description" disabled={!asset.orbital_description}>
                Description
              </TabsTrigger>
              <TabsTrigger value="technical">Technical</TabsTrigger>
            </TabsList>

            {/* Details is the default and is always short — that is the point
                of the split. On an enriched asset the marketplace bullet list
                alone ran past 1,400px and pushed every action below the fold. */}
            <TabsContent value="details" className="flex min-w-0 flex-col gap-2 pt-3">
              {hasMatch ? (
                <>
                  <StatRow
                    label="Rating"
                    value={
                      asset.orbital_rating_average != null
                        ? `${formatRating(asset.orbital_rating_average)} · ${asset.orbital_rating_count ?? 0} reviews`
                        : 'Not rated'
                    }
                  />
                  <StatRow label="Released" value={formatDate(asset.orbital_release_date)} />
                  <StatRow label="Updated" value={formatDate(asset.orbital_last_modified)} />
                </>
              ) : (
                <UnmatchedNotice onMatch={() => setMatchOpen(true)} />
              )}
              <StatRow
                label="Engine"
                value={formatSupportedVersions(asset.orbital_supported_versions)}
              />
              <StatRow label="Added" value={formatDate(asset.created_date)} />
              <StatRow
                label="Size on disk"
                value={formatBytes(asset.file_size, asset.file_size_is_partial)}
                hint={
                  asset.file_size_is_partial
                    ? 'At least this size. The scanner stopped counting at its per-pack file limit, so the real total is larger.'
                    : undefined
                }
              />
            </TabsContent>

            <TabsContent value="description" className="min-w-0 pt-3">
              <p className="whitespace-pre-line break-words cap-12-prose text-surface-200">
                {asset.orbital_description}
              </p>
            </TabsContent>

            <TabsContent value="technical" className="flex min-w-0 flex-col gap-4 pt-3">
              <ProvenanceBlock assetId={assetId} asset={asset} />
              {asset.orbital_technical_details ? (
                <Section title="Marketplace details">
                  <p className="whitespace-pre-line break-words cap-12-prose text-surface-200">
                    {asset.orbital_technical_details}
                  </p>
                </Section>
              ) : null}
            </TabsContent>
          </Tabs>

          <Separator />
          <NotesSection assetId={assetId} />
        </div>
      </div>

      {/* Action footer, OUTSIDE the scroll container. DESIGN.md: "Actions pin
          to a footer that never scrolls away." On an enriched asset the
          description alone ran past 1,400px, which pushed every button below
          the fold — the panel showed you an asset you could not act on. */}
      <div className="flex shrink-0 flex-col gap-2 border-t border-surface-800/60 bg-surface-925 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.omnidex?.shell?.openFileLocation(asset.file_path)}
          >
            <Folder size={12} />
            Open folder
          </Button>
          <Button
            variant={hasMatch ? 'ghost' : 'primary'}
            size="sm"
            onClick={() => setMatchOpen(true)}
          >
            <Wand2 size={12} />
            {hasMatch ? 'Change match' : 'Find match'}
          </Button>
          {asset.orbital_source_url ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                asset.orbital_source_url &&
                window.omnidex?.shell?.openExternal(asset.orbital_source_url)
              }
            >
              <ExternalLink size={12} />
              Orbital
            </Button>
          ) : null}
          <Button
            variant={asset.is_favorite ? 'primary' : 'outline'}
            size="sm"
            className="ml-auto"
            disabled={setFavorite.isPending}
            onClick={() => setFavorite.mutate({ ids: [assetId], favorite: !asset.is_favorite })}
          >
            <Heart size={12} fill={asset.is_favorite ? 'currentColor' : 'none'} />
            {asset.is_favorite ? 'Favorited' : 'Favorite'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => openTagging(assetId)}
          >
            <Tag size={12} />
            Manage tags
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => openAddToCollection([assetId])}
          >
            <FolderPlus size={12} />
            Add to collection
          </Button>
        </div>
      </div>
    </>
  );
}

/** Max chars persisted per asset note — generous, just guards a runaway paste. */
const NOTE_MAX_LENGTH = 5_000;
/** Debounce window for note-text autosave. */
const NOTE_SAVE_DELAY = 600;

/**
 * Per-asset Notes: a free-text field plus a 0–5 (half-step) star rating, both
 * bound to `notes.get` / `notes.upsert`. Text autosaves on a debounce; the
 * rating saves immediately on click. We carry the rating and text together on
 * every upsert (the request replaces the row), so a rating click never wipes
 * an in-flight text edit and vice-versa.
 */
function NotesSection({ assetId }: { readonly assetId: number }) {
  const utils = trpc.useUtils();
  const noteQuery = trpc.notes.get.useQuery(assetId);
  const upsert = trpc.notes.upsert.useMutation({
    onSuccess: () => {
      void utils.notes.get.invalidate(assetId);
    },
  });

  const [text, setText] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Seed local state from the loaded note whenever the asset changes. Keyed on
  // assetId (not the note object) so re-renders from autosave don't clobber the
  // field mid-edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset local draft only when the inspected asset changes
  useEffect(() => {
    if (noteQuery.data) {
      setText(noteQuery.data.note_text ?? '');
      setRating(noteQuery.data.rating);
    } else if (noteQuery.isFetched) {
      setText('');
      setRating(null);
    }
  }, [assetId, noteQuery.isFetched]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const persist = useCallback(
    (nextText: string, nextRating: number | null) => {
      upsert.mutate({
        asset_id: assetId,
        note_text: nextText.trim() ? nextText : null,
        rating: nextRating,
        tested_ue_versions: null,
        reminders: null,
      });
    },
    [assetId, upsert],
  );

  const onTextChange = (value: string) => {
    const clipped = value.slice(0, NOTE_MAX_LENGTH);
    setText(clipped);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(clipped, rating), NOTE_SAVE_DELAY);
  };

  const onRate = (value: number) => {
    // Click the current rating again to clear it.
    const next = rating === value ? null : value;
    setRating(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    persist(text, next);
  };

  return (
    <Section title="Notes">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-0.5">
          {[1, 2, 3, 4, 5].map((star) => {
            const active = (hover ?? rating ?? 0) >= star;
            return (
              <button
                key={star}
                type="button"
                onClick={() => onRate(star)}
                onMouseEnter={() => setHover(star)}
                onMouseLeave={() => setHover(null)}
                aria-label={`Rate ${star} star${star > 1 ? 's' : ''}`}
                className="flex h-6 w-6 items-center justify-center rounded-sm text-surface-600 transition-colors hover:text-accent-400"
              >
                <Star
                  size={15}
                  strokeWidth={1.5}
                  className={active ? 'fill-accent-400 text-accent-400' : ''}
                />
              </button>
            );
          })}
        </div>
        {rating != null ? (
          <span className="font-mono cap-11 tabular-nums text-surface-400">
            {formatRating(rating)}
          </span>
        ) : (
          <span className="font-mono cap-11 text-surface-400">Not rated</span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        onBlur={() => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          persist(text, rating);
        }}
        placeholder="Add a private note for this asset…"
        rows={4}
        maxLength={NOTE_MAX_LENGTH}
        className="w-full resize-y rounded-sm border border-surface-800/60 bg-surface-950 px-2.5 py-2 cap-12-prose text-surface-100 placeholder:text-surface-600 transition-colors hover:border-surface-700 focus:border-accent-500 focus:outline-none"
      />
    </Section>
  );
}

/**
 * Definition row: fixed label gutter, value left-aligned against it.
 *
 * This was `justify-between`, which flings the label to the left edge and the
 * value to the right of a panel the user can drag to 560px — half a foot of
 * empty space between "Size on disk" and "6.6 GB", with no dot leaders and no
 * zebra to carry the eye across. The classic leader-line failure, and it got
 * worse every time the panel widened. A fixed gutter cannot.
 */
function StatRow({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    // cap-* stays off the grid container: Capsize trims with ::before/::after,
    // and a grid container's pseudo-elements ARE grid items, so a cap class
    // here eats column 1 and pushes the label and value out of alignment.
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-baseline gap-3 font-mono">
      <span className="cap-11 uppercase tracking-[0.1em] text-surface-500">{label}</span>
      <span
        className="min-w-0 break-words cap-11 tabular-nums text-surface-200"
        title={hint ?? value}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The unselected inspector.
 *
 * This pane was an icon and the sentence "Select an asset to inspect." — and
 * because it is `hidden xl:flex`, the wider the monitor the more of it you
 * donated. A quarter of a 2,560px window spent restating that nothing is
 * selected, which the user already knows.
 *
 * Unselected state is the right home for library health: the numbers that
 * describe the whole library are only interesting when you are not looking at
 * one asset. Every line here is a verb, not a readout.
 */
function LibraryHealthAside() {
  const stats = trpc.assets.stats.useQuery();
  const ecosystems = trpc.assets.ecosystemCounts.useQuery();
  const s = stats.data;

  const topEcosystems = useMemo(() => {
    const entries = Object.entries(ecosystems.data ?? {});
    return entries.sort(([, a], [, b]) => b - a).slice(0, 4);
  }, [ecosystems.data]);

  if (!s) {
    return (
      <div className="flex flex-col gap-3 p-5">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const matched = s.with_orbital;
  const pct = s.total > 0 ? Math.round((matched / s.total) * 100) : 0;

  return (
    <div className="flex min-w-0 flex-col gap-5 p-5">
      <span className="font-mono cap-10 uppercase tracking-[0.18em] text-surface-400">
        Library health
      </span>

      {s.unmatched > 0 ? (
        <a
          href="#/health"
          className="flex flex-col gap-1 rounded-md border border-surface-800 bg-surface-900 p-3 no-underline transition-colors hover:border-accent-500/50"
        >
          <span className="font-mono tabular-nums cap-23 font-semibold text-surface-50">
            {formatCount(s.unmatched)}
          </span>
          <span className="cap-12 text-surface-300">packs with no marketplace match</span>
          <span className="cap-12 text-accent-300">Review unmatched</span>
        </a>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="cap-12 text-surface-300">Matched</span>
          <span className="font-mono tabular-nums cap-12 text-surface-200">
            {formatCount(matched)} of {formatCount(s.total)} · {pct}%
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-xs bg-surface-800">
          <div className="h-1 rounded-xs bg-accent-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {topEcosystems.length > 0 ? (
        <Section title="Ecosystems">
          <div className="flex flex-col gap-1.5">
            {topEcosystems.map(([name, count]) => (
              <div key={name} className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate cap-12 text-surface-300">
                  {formatTaxonomyLabel(name)}
                </span>
                <span className="font-mono tabular-nums cap-11 text-surface-400">
                  {formatCount(count)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Storage">
        <div className="flex items-baseline justify-between gap-2">
          <span className="cap-12 text-surface-300">Packs on disk</span>
          <span className="font-mono tabular-nums cap-12 text-surface-200">
            {formatBytes(s.size_bytes)}
          </span>
        </div>
        {s.courses > 0 ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="cap-12 text-surface-300">Courses</span>
            <span className="font-mono tabular-nums cap-12 text-surface-200">
              {formatCount(s.courses)}
            </span>
          </div>
        ) : null}
      </Section>

      <p className="cap-11 text-surface-500">Select an asset to inspect it.</p>
    </div>
  );
}

/**
 * What an un-enriched asset shows instead of three em-dashes.
 *
 * "Rating —", "Released —", "Updated —" reads as "this asset has no rating".
 * It actually means "we never looked it up". Three dashes stacked in the most
 * prominent block on the panel train the user to read the inspector as empty
 * rather than as pending — and 88% of the library lands here. One line with
 * the verb attached says the true thing and offers the fix.
 */
function UnmatchedNotice({ onMatch }: { readonly onMatch: () => void }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-surface-800 bg-surface-900 px-3 py-2">
      <span className="cap-12 text-surface-300">Not matched to a marketplace listing</span>
      <button
        type="button"
        onClick={onMatch}
        className="cap-12 font-medium text-accent-300 underline underline-offset-2 hover:text-accent-200"
      >
        Match now
      </button>
    </div>
  );
}

/**
 * Where this pack actually came from.
 *
 * The app's whole job is provenance and the inspector never showed any: no
 * path, no scan location, no duplicate count. "Open folder" was offered
 * without ever saying which folder.
 */
function ProvenanceBlock({
  assetId,
  asset,
}: {
  readonly assetId: number;
  readonly asset: { readonly file_path: string | null; readonly scan_location_id: number | null };
}) {
  const locations = trpc.scanLocations.list.useQuery();
  const duplicates = trpc.assets.duplicates.useQuery(assetId);
  const [copied, setCopied] = useState(false);

  const sourceName = useMemo(() => {
    if (asset.scan_location_id == null) return null;
    if (asset.scan_location_id === -1) return 'FAB vault';
    const rows = (locations.data ?? []) as ReadonlyArray<{ id: number; name: string }>;
    return rows.find((l) => l.id === asset.scan_location_id)?.name ?? null;
  }, [asset.scan_location_id, locations.data]);

  const dupeLocationNames = useMemo(() => {
    const rows = (locations.data ?? []) as ReadonlyArray<{ id: number; name: string }>;
    return (duplicates.data?.scan_location_ids ?? [])
      .map((id) => (id === -1 ? 'FAB vault' : rows.find((l) => l.id === id)?.name))
      .filter((n): n is string => Boolean(n));
  }, [duplicates.data, locations.data]);

  async function copyPath() {
    if (!asset.file_path) return;
    await navigator.clipboard.writeText(asset.file_path);
    setCopied(true);
    // Revert the affordance rather than leaving a permanent "Copied" that
    // stops reading as a button.
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Section title="Location">
      <div className="flex min-w-0 flex-col gap-2">
        {sourceName ? (
          <div className="flex items-center gap-2">
            <Badge variant="outline">{sourceName}</Badge>
          </div>
        ) : null}

        {asset.file_path ? (
          <div className="flex min-w-0 items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md bg-surface-900 px-2 py-1 font-mono cap-11 text-surface-300">
              {asset.file_path}
            </code>
            <button
              type="button"
              onClick={() => void copyPath()}
              aria-label="Copy path"
              className="shrink-0 rounded-md p-1 text-surface-400 transition-colors hover:bg-surface-800 hover:text-surface-100"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        ) : (
          <span className="font-mono cap-11 text-surface-500">No path recorded</span>
        )}

        {duplicates.data && duplicates.data.count > 0 ? (
          <span className="cap-11 text-warning-300">
            {duplicates.data.count} other {duplicates.data.count === 1 ? 'copy' : 'copies'} in your
            library
            {dupeLocationNames.length > 0 ? ` — ${dupeLocationNames.join(', ')}` : ''}
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono cap-10 uppercase tracking-[0.14em] text-surface-400">{title}</span>
      {children}
    </div>
  );
}

function Gallery({
  asset,
}: {
  readonly asset: {
    id: number | null;
    orbital_gallery_images: string | null;
    orbital_thumbnail_url: string | null;
    thumbnail_path: string | null;
  };
}) {
  const images = useMemo(() => parseGallery(asset), [asset]);
  const [index, setIndex] = useState(0);
  const [imgError, setImgError] = useState(false);

  // Reset to the first image whenever the user switches to a different asset.
  // Without this, navigating gallery 1 to image 4, then selecting a new
  // asset, would land you on that asset's 4th image — which is often a
  // weird mid-content frame instead of the cover.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset the gallery to the first image whenever the inspected asset changes
  useEffect(() => {
    setIndex(0);
    setImgError(false);
  }, [asset.id]);

  const goPrev = useCallback(() => {
    setImgError(false);
    setIndex((i) => (i - 1 + images.length) % images.length);
  }, [images.length]);
  const goNext = useCallback(() => {
    setImgError(false);
    setIndex((i) => (i + 1) % images.length);
  }, [images.length]);

  // Keyboard nav — ←/→ step through gallery images. Skip when the user is
  // typing into a search input or similar so we don't hijack their cursor.
  useEffect(() => {
    if (images.length <= 1) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [images.length, goPrev, goNext]);

  if (images.length === 0) {
    return (
      <div
        className="flex w-full items-center justify-center rounded-md bg-surface-900 text-surface-600"
        style={{ aspectRatio: '16 / 9', maxHeight: '50vh' }}
      >
        <ImageIcon size={36} strokeWidth={1.25} />
      </div>
    );
  }

  const current = images[index] ?? images[0];
  const safeIndex = Math.min(index, images.length - 1);

  return (
    <div className="flex flex-col gap-2">
      {/*
        Belt-and-suspenders sizing: `aspect-video` (Tailwind) handles the
        ratio in modern browsers; `aspectRatio` inline style is the same
        contract via the standard CSS property; `max-h` clamps absolute
        height so a thumbnail with unusual natural dimensions can never
        push the gallery taller than ~half the panel — was producing a
        "blown-up" image when a thumbnail's natural aspect didn't agree
        with the container during the initial paint.

        `key={asset.id}` on the img remounts the element on selection
        change so a stale frame from the previous asset can never linger.
      */}
      <div
        className="relative w-full overflow-hidden rounded-md bg-surface-900"
        style={{ aspectRatio: '16 / 9', maxHeight: '50vh' }}
      >
        {current && !imgError ? (
          <img
            key={`${asset.id}-${safeIndex}`}
            src={current}
            alt=""
            onError={() => setImgError(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-surface-600">
            <ImageIcon size={36} strokeWidth={1.25} />
          </div>
        )}
        {images.length > 1 ? (
          <>
            <button
              type="button"
              onClick={goPrev}
              aria-label="Previous image"
              className="absolute left-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface-950/70 text-surface-100 backdrop-blur transition-colors hover:bg-surface-950/90"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              type="button"
              onClick={goNext}
              aria-label="Next image"
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface-950/70 text-surface-100 backdrop-blur transition-colors hover:bg-surface-950/90"
            >
              <ChevronRight size={14} />
            </button>
            <div
              data-testid="gallery-counter"
              className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-surface-950/70 px-2 py-0.5 font-mono cap-10 tabular-nums text-surface-200 backdrop-blur"
            >
              {safeIndex + 1} / {images.length}
            </div>
          </>
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {images.map((src, i) => (
            <button
              key={src}
              type="button"
              onClick={() => {
                setImgError(false);
                setIndex(i);
              }}
              aria-label={`Image ${i + 1}`}
              aria-current={i === safeIndex}
              className={`relative h-12 w-20 shrink-0 overflow-hidden rounded border transition-all ${
                i === safeIndex
                  ? 'border-accent-500 ring-1 ring-accent-500/40'
                  : 'border-surface-800 hover:border-surface-700'
              }`}
            >
              <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
