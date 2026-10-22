import type { ReactNode } from 'react';
import { create } from 'zustand';

/**
 * Spec for the shared confirmation alert. The trigger supplies the copy and an
 * `onConfirm` callback (which may run a tRPC mutation); `ModalHost` renders the
 * single mounted `ConfirmationAlert` and invokes it.
 */
export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm button as a danger variant (delete/destroy flows). */
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
}

/**
 * Modal-orchestration store. One slice drives the three shared modals mounted
 * once by `ModalHost` (TaggingModal / AddToCollectionDialog / ConfirmationAlert).
 *
 * Host-fetches variant: `openTagging` takes only an `assetId`; `ModalHost`
 * runs `trpc.assets.getTags.useQuery(assetId)` to seed the modal's initial
 * tags, so every trigger (card / context menu / inspector) stays trivial and
 * never has to pre-fetch tags itself.
 *
 * Mirrors `stores/ui.ts`: a plain `create` slice with selector-friendly state,
 * each open/close setter just sets or clears its slot.
 */
interface ModalsState {
  /** Active tagging target, or `null` when the tagging modal is closed. */
  tagging: { assetId: number } | null;
  /**
   * Assets awaiting a bulk tag ADD, or `null` when closed. Separate from
   * `tagging`: that one edits one asset's whole tag set, this one applies a
   * delta to many, and conflating them is how a bulk replace gets shipped.
   */
  bulkTagging: { assetIds: number[] } | null;
  /** Asset ids to add to a collection, or `null` when the dialog is closed. */
  addToCollection: { assetIds: number[] } | null;
  /** Active confirmation spec, or `null` when no confirm is open. */
  confirm: ConfirmSpec | null;
  openTagging: (assetId: number) => void;
  openBulkTagging: (assetIds: number[]) => void;
  openAddToCollection: (assetIds: number[]) => void;
  openConfirm: (spec: ConfirmSpec) => void;
  closeTagging: () => void;
  closeBulkTagging: () => void;
  closeAddToCollection: () => void;
  closeConfirm: () => void;
}

export const useModals = create<ModalsState>((set) => ({
  tagging: null,
  bulkTagging: null,
  addToCollection: null,
  confirm: null,
  openTagging: (assetId) => set({ tagging: { assetId } }),
  openBulkTagging: (assetIds) => set({ bulkTagging: { assetIds } }),
  openAddToCollection: (assetIds) => set({ addToCollection: { assetIds } }),
  openConfirm: (spec) => set({ confirm: spec }),
  closeTagging: () => set({ tagging: null }),
  closeBulkTagging: () => set({ bulkTagging: null }),
  closeAddToCollection: () => set({ addToCollection: null }),
  closeConfirm: () => set({ confirm: null }),
}));
