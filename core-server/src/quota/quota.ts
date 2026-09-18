import { QuotaExceededError } from '../lib/errors';
import { DEFAULT_SETTINGS } from '../repositories/defaultSettings';

export interface OrgUsageRepoLike {
  getToday(orgId: string): Promise<{ storage_bytes: number }>;
  reserve(orgId: string, column: 'images_generated' | 'messages_drafted', limit: number): Promise<boolean>;
}

export interface SettingsRepoLike {
  get(key: 'quota.default_daily_images'): Promise<number>;
  get(key: 'quota.default_storage_bytes'): Promise<number>;
  get(key: 'quota.default_daily_drafts'): Promise<number>;
}

type NumericQuotaKey = 'quota.default_daily_images' | 'quota.default_storage_bytes' | 'quota.default_daily_drafts';

/** A malformed app_settings value must never turn into "unlimited" (NaN comparisons are always false). */
async function readLimit(settingsRepo: SettingsRepoLike, key: NumericQuotaKey): Promise<number> {
  const raw: unknown = await settingsRepo.get(key as 'quota.default_daily_images');
  // Number(null) and Number('') are 0 — treat anything but a real number (or numeric string) as malformed.
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_SETTINGS[key];
}

/**
 * Enforces crmex.md §13.5 per firm (§15.3): checked BEFORE calling the
 * provider, so no cost is incurred on a request that will be rejected
 * (QTA-04). The daily count is reserved atomically (compare-and-set in
 * orgUsageRepo), so concurrent requests from one firm cannot overshoot the
 * limit. Throws QuotaExceededError (HTTP 429) rather than returning a
 * boolean, so callers can't proceed on a quota failure by forgetting a check.
 *
 * The storage ceiling is a read-then-check (not reserved): the object's size
 * isn't known until after generation, so concurrent generations can each
 * pass the check and together exceed it by at most their own sizes.
 */
export async function reserveImageGeneration(deps: {
  orgUsageRepo: OrgUsageRepoLike;
  settingsRepo: SettingsRepoLike;
  orgId: string;
}): Promise<void> {
  const [dailyLimit, storageLimit, usage] = await Promise.all([
    readLimit(deps.settingsRepo, 'quota.default_daily_images'),
    readLimit(deps.settingsRepo, 'quota.default_storage_bytes'),
    deps.orgUsageRepo.getToday(deps.orgId),
  ]);

  if (usage.storage_bytes >= storageLimit) {
    throw new QuotaExceededError(`Storage quota reached (${storageLimit} bytes).`);
  }
  if (!(await deps.orgUsageRepo.reserve(deps.orgId, 'images_generated', dailyLimit))) {
    throw new QuotaExceededError(`Daily image generation quota reached (${dailyLimit} per day).`);
  }
}

/** Per-firm daily draft quota (org_usage_daily.messages_drafted), reserved before the LLM call. */
export async function reserveMessageDraft(deps: {
  orgUsageRepo: OrgUsageRepoLike;
  settingsRepo: SettingsRepoLike;
  orgId: string;
}): Promise<void> {
  const dailyLimit = await readLimit(deps.settingsRepo, 'quota.default_daily_drafts');
  if (!(await deps.orgUsageRepo.reserve(deps.orgId, 'messages_drafted', dailyLimit))) {
    throw new QuotaExceededError(`Daily message drafting quota reached (${dailyLimit} per day).`);
  }
}
