import { describe, expect, it, vi } from 'vitest';
import { reserveImageGeneration, reserveMessageDraft } from '../../src/quota/quota';
import { QuotaExceededError } from '../../src/lib/errors';

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

function deps(usage: { images_generated: number; storage_bytes: number }, limits: { images: unknown; storage: unknown; drafts?: unknown }) {
  const counters = { images_generated: usage.images_generated, messages_drafted: 0 };
  return {
    orgUsageRepo: {
      getToday: vi.fn().mockResolvedValue(usage),
      reserve: vi.fn(async (_org: string, column: 'images_generated' | 'messages_drafted', limit: number) => {
        if (counters[column] + 1 > limit) return false;
        counters[column] += 1;
        return true;
      }),
    },
    settingsRepo: {
      get: vi.fn((key: string) => {
        if (key === 'quota.default_daily_images') return Promise.resolve(limits.images);
        if (key === 'quota.default_storage_bytes') return Promise.resolve(limits.storage);
        if (key === 'quota.default_daily_drafts') return Promise.resolve(limits.drafts);
        throw new Error(`unexpected key ${key}`);
      }),
    },
    orgId: ORG,
  } as any;
}

describe('quota/quota', () => {
  it('QTA-01: allows generation within quota and reserves one unit for the firm', async () => {
    const d = deps({ images_generated: 3, storage_bytes: 100 }, { images: 10, storage: 1000 });
    await expect(reserveImageGeneration(d)).resolves.toBeUndefined();
    expect(d.orgUsageRepo.reserve).toHaveBeenCalledWith(ORG, 'images_generated', 10);
  });

  it('QTA-02: rejects generation at the daily image quota', async () => {
    await expect(
      reserveImageGeneration(deps({ images_generated: 10, storage_bytes: 0 }, { images: 10, storage: 1000 })),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('QTA-04: rejects when storage quota is exceeded, without reserving', async () => {
    const d = deps({ images_generated: 0, storage_bytes: 1000 }, { images: 10, storage: 1000 });
    await expect(reserveImageGeneration(d)).rejects.toBeInstanceOf(QuotaExceededError);
    expect(d.orgUsageRepo.reserve).not.toHaveBeenCalled();
  });

  it('a malformed setting falls back to the seeded default instead of becoming unlimited', async () => {
    const d = deps({ images_generated: 0, storage_bytes: 0 }, { images: 'lots', storage: 1000, drafts: null });
    await reserveImageGeneration(d);
    expect(d.orgUsageRepo.reserve).toHaveBeenCalledWith(ORG, 'images_generated', 50);
    await reserveMessageDraft(d);
    expect(d.orgUsageRepo.reserve).toHaveBeenCalledWith(ORG, 'messages_drafted', 200);
  });
});
