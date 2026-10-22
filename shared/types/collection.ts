/**
 * Collection type definitions for Omnidex
 *
 * Collections (Starter Kits) allow users to organize assets into themed groups
 * for easy access and project planning.
 *
 * Database Schema Reference (migration 20260127180100):
 * - collections: id, name, description, color, icon, is_smart, smart_filter,
 *                sort_order, created_at, updated_at
 * - collection_items: collection_id, asset_id, added_at, sort_order
 */

/**
 * Base collection record from the database
 */
export interface Collection {
  /** Primary key */
  id: number;
  /** User-defined name (required) */
  name: string;
  /** Optional description */
  description: string | null;
  /** Hex color for visual distinction (default: #3b82f6) */
  color: string;
  /** Optional icon identifier */
  icon: string | null;
  /** Whether this is a smart collection (filter-based) */
  is_smart: boolean;
  /** JSON filter criteria for smart collections */
  smart_filter: string | null;
  /** Order position in sidebar (lower = higher) */
  sort_order: number;
  /** ISO timestamp of creation */
  created_at: string;
  /** ISO timestamp of last update */
  updated_at: string;
}

/**
 * Collection with computed asset count for list display
 */
export interface CollectionWithCount extends Omit<Collection, 'smart_filter'> {
  /** Number of assets in this collection */
  asset_count: number;
}

/**
 * Input for creating a new collection
 */
export interface CreateCollectionInput {
  /** Required: Collection name */
  name: string;
  /** Optional: Description text */
  description?: string;
  /** Optional: Hex color (defaults to #3b82f6) */
  color?: string;
  /** Optional: Icon identifier */
  icon?: string;
}

/**
 * Input for updating an existing collection
 * All fields optional - only provided fields are updated
 */
export interface UpdateCollectionInput {
  /** New name */
  name?: string;
  /** New description (empty string to clear) */
  description?: string;
  /** New color */
  color?: string;
  /** New icon */
  icon?: string;
  /** New sort order */
  sort_order?: number;
}

/**
 * Collection item (asset membership in a collection)
 */
export interface CollectionItem {
  /** Foreign key to collections table */
  collection_id: number;
  /** Foreign key to assets table */
  asset_id: number;
  /** ISO timestamp when asset was added */
  added_at: string;
  /** Order position within collection */
  sort_order: number;
}

/**
 * Predefined color palette for collection color picker
 */
export const COLLECTION_COLORS = [
  '#f97316', // Orange (default)
  '#06b6d4', // Cyan
  '#10b981', // Emerald
  '#fbbf24', // Amber
  '#ef4444', // Red
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#3b82f6', // Blue
  '#84cc16', // Lime
  '#a78bfa', // Violet
] as const;

/**
 * Type for valid collection colors
 */
export type CollectionColor = (typeof COLLECTION_COLORS)[number] | string;

/**
 * Default values for new collections
 */
export const DEFAULT_COLLECTION: Partial<CreateCollectionInput> = {
  color: '#f97316',
};

/**
 * Validation constants
 */
export const COLLECTION_VALIDATION = {
  /** Maximum length for collection name */
  MAX_NAME_LENGTH: 100,
  /** Maximum length for collection description */
  MAX_DESCRIPTION_LENGTH: 500,
  /** Regex for valid hex color */
  HEX_COLOR_REGEX: /^#([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/,
} as const;

/**
 * Validate hex color format
 */
export function isValidHexColor(color: string): boolean {
  return COLLECTION_VALIDATION.HEX_COLOR_REGEX.test(color);
}

/**
 * Validate collection name
 */
export function isValidCollectionName(name: string): { valid: boolean; error?: string } {
  const trimmed = name.trim();

  if (!trimmed) {
    return { valid: false, error: 'Collection name is required' };
  }

  if (trimmed.length > COLLECTION_VALIDATION.MAX_NAME_LENGTH) {
    return {
      valid: false,
      error: `Name must be ${COLLECTION_VALIDATION.MAX_NAME_LENGTH} characters or less`,
    };
  }

  return { valid: true };
}

/**
 * Validate collection description
 */
export function isValidCollectionDescription(description: string | undefined): {
  valid: boolean;
  error?: string;
} {
  if (!description) {
    return { valid: true };
  }

  if (description.length > COLLECTION_VALIDATION.MAX_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      error: `Description must be ${COLLECTION_VALIDATION.MAX_DESCRIPTION_LENGTH} characters or less`,
    };
  }

  return { valid: true };
}
