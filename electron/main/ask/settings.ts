import type { Database } from 'better-sqlite3';
import { appSettingsRepo } from '../db/repos';

/**
 * Ask configuration, persisted in the existing `app_settings` key-value store.
 * Local-first by explicit user preference: the default provider is the
 * llama-swap stack, and no configuration at all yields a working (if
 * stack-dependent) setup with zero keys and zero cost.
 */

export type AskProvider = 'local' | 'claude-code';

export interface AskSettings {
  provider: AskProvider;
  localBaseUrl: string;
  localModel: string;
  contextBudget: number;
}

export const ASK_SETTING_KEYS = {
  provider: 'ask.provider',
  localBaseUrl: 'ask.local_base_url',
  localModel: 'ask.local_model',
  contextBudget: 'ask.context_budget',
} as const;

export const ASK_DEFAULTS: AskSettings = {
  provider: 'local',
  localBaseUrl: 'http://localhost:8080/v1',
  // The llama-swap daily tier — 196K context on the measured config.
  localModel: 'qwen3.6',
  contextBudget: 120_000,
};

function read(db: Database, key: string): string | null {
  return appSettingsRepo.getSetting(db, key)?.value ?? null;
}

export function readAskSettings(db: Database): AskSettings {
  const provider = read(db, ASK_SETTING_KEYS.provider);
  // Number(null) is 0 — finite — so an absent setting must bail to the default
  // BEFORE the numeric clamp, or every fresh install runs at the 8k floor
  // instead of 120k. Caught live: "Context: 3 of 88 lessons (~6k tokens)".
  const budgetStr = read(db, ASK_SETTING_KEYS.contextBudget);
  const budgetRaw = budgetStr === null ? Number.NaN : Number(budgetStr);
  return {
    provider: provider === 'claude-code' ? 'claude-code' : 'local',
    localBaseUrl: read(db, ASK_SETTING_KEYS.localBaseUrl) ?? ASK_DEFAULTS.localBaseUrl,
    localModel: read(db, ASK_SETTING_KEYS.localModel) ?? ASK_DEFAULTS.localModel,
    contextBudget: Number.isFinite(budgetRaw)
      ? Math.min(Math.max(Math.round(budgetRaw), 8_000), 900_000)
      : ASK_DEFAULTS.contextBudget,
  };
}
