import type { SupabaseLike } from '../db/types';
import { DEFAULT_SETTINGS, type SettingKey, type SettingValue } from './defaultSettings';

/**
 * Reads global app_settings (crmex.md §13.3). core-server is the only
 * reader/writer (service role); there is no per-user override. Falls back
 * to DEFAULT_SETTINGS whenever a row is missing (QTA-08).
 */
export function createSettingsRepo(db: SupabaseLike) {
  return {
    async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
      const { data, error } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
      if (error) {
        throw new Error(`settingsRepo.get(${key}) failed: ${error.message}`);
      }
      const row = data as { value: unknown } | null;
      if (row && row.value !== undefined && row.value !== null) {
        return row.value as SettingValue<K>;
      }
      return DEFAULT_SETTINGS[key];
    },
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
