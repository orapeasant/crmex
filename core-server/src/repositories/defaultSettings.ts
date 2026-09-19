// Sensible defaults for every app_settings key (crmex.md §13.3/§14,
// test-plan.md QTA-08). These are seeded into the database by
// supabase/migrations/20250101000200_admin_schema.sql, and mirrored here as
// a second line of defence in settingsRepo: if a fresh deploy is ever
// queried before migrations/seeds have run, or a row is missing, the system
// is never "unlimited by accident."

export interface SettingsShape {
  'retention.unsent_image_ttl_days': number;
  'retention.sent_image_ttl_days': number;
  'quota.default_daily_images': number;
  'quota.default_storage_bytes': number;
  /** Not seeded by a migration yet — settingsRepo falls back to this default until a row is inserted. */
  'quota.default_daily_drafts': number;
  /**
   * Per-request cap for POST /images/upload (§18.4, CAM-15). Not seeded by a
   * migration yet — settingsRepo falls back to this default until a row is
   * inserted. 10 MB comfortably covers a canvas.toBlob PNG of a phone photo
   * while keeping a single request from parking an unreasonable amount of
   * memory before sanitizePng() even runs.
   */
  'quota.max_upload_bytes': number;
  'limits.max_batch_recipients': number;
  'pacing.min_interval_ms': number;
  'pacing.max_interval_ms': number;
  'providers.llm': string;
  'providers.image_gen': string;
  'providers.image_search': string;
  'features.image_search_enabled': boolean;
}

export const DEFAULT_SETTINGS: SettingsShape = {
  'retention.unsent_image_ttl_days': 7,
  'retention.sent_image_ttl_days': 30,
  'quota.default_daily_images': 50,
  'quota.default_storage_bytes': 500_000_000,
  'quota.default_daily_drafts': 200,
  'quota.max_upload_bytes': 10_000_000,
  'limits.max_batch_recipients': 200,
  'pacing.min_interval_ms': 7000,
  'pacing.max_interval_ms': 18000,
  'providers.llm': 'anthropic',
  'providers.image_gen': 'openai',
  'providers.image_search': 'unsplash',
  'features.image_search_enabled': true,
};

export type SettingKey = keyof SettingsShape;
export type SettingValue<K extends SettingKey> = SettingsShape[K];
