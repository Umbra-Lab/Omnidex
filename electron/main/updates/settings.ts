import type { Database } from 'better-sqlite3';
import { appSettingsRepo } from '../db/repos';

/**
 * Update-check preferences, persisted in the existing `app_settings` store.
 *
 * `autoCheck` is the only switch and it defaults to OFF. It gates the scheduled
 * check (at launch and every 4 hours) and nothing else: the "Check for updates"
 * button always works, because pressing it is the consent for that one request.
 * PRIVACY.md and Settings → About both describe exactly this, so changing the
 * default means changing them too.
 */
export interface UpdateSettings {
  autoCheck: boolean;
}

export const UPDATE_SETTING_KEYS = {
  autoCheck: 'updates.auto_check',
} as const;

export const UPDATE_DEFAULTS: UpdateSettings = {
  autoCheck: false,
};

const AUTO_CHECK_DESCRIPTION =
  'Check GitHub for a newer Omnidex release at launch and every 4 hours. Off by default.';

export function readUpdateSettings(db: Database): UpdateSettings {
  return {
    autoCheck: appSettingsRepo.getBooleanSetting(
      db,
      UPDATE_SETTING_KEYS.autoCheck,
      UPDATE_DEFAULTS.autoCheck,
    ),
  };
}

export function writeUpdateSettings(db: Database, patch: Partial<UpdateSettings>): UpdateSettings {
  if (patch.autoCheck !== undefined) {
    appSettingsRepo.setBooleanSetting(
      db,
      UPDATE_SETTING_KEYS.autoCheck,
      patch.autoCheck,
      AUTO_CHECK_DESCRIPTION,
    );
  }
  return readUpdateSettings(db);
}
