import { describe, it, expect } from 'vitest';
import { planEviction, localCachePath, assertSafeMediaPath, expectedObjectPath } from './imageCache.js';
import type { ImageCacheRow } from '../types.js';

function row(mediaPath: string, bytes: number, lastUsedAt: number): ImageCacheRow {
  return { mediaPath, userId: 'u1', localFile: `/cache/${mediaPath}`, bytes, cachedAt: 0, lastUsedAt };
}

describe('planEviction (CSH-03)', () => {
  it('evicts oldest-by-last_used_at first, stopping once under budget', () => {
    const rows = [row('a.png', 50, 1), row('b.png', 50, 2), row('c.png', 50, 3)];
    const evicted = planEviction(rows, { maxBytes: 100 }, new Set());
    expect(evicted.map((r) => r.mediaPath)).toEqual(['a.png']);
  });

  it('never evicts the in-use image even if it is the oldest', () => {
    const rows = [row('a.png', 50, 1), row('b.png', 50, 2)];
    const evicted = planEviction(rows, { maxBytes: 40 }, new Set(['a.png']));
    expect(evicted.map((r) => r.mediaPath)).toEqual(['b.png']);
  });

  it('evicts nothing when under budget', () => {
    const rows = [row('a.png', 10, 1)];
    expect(planEviction(rows, { maxBytes: 100 }, new Set())).toHaveLength(0);
  });
});

describe('path safety (ISO-15..19)', () => {
  it('ISO-15: rejects a traversal path', () => {
    expect(() => assertSafeMediaPath('../userA/secret.png')).toThrow();
  });

  it('ISO-16: rejects an absolute path', () => {
    expect(() => assertSafeMediaPath('/etc/passwd')).toThrow();
    expect(() => assertSafeMediaPath('C:\\secret\\file.png')).toThrow();
  });

  it('ISO-17: rejects a URL-encoded traversal after decoding', () => {
    expect(() => assertSafeMediaPath('%2e%2e%2fuserA%2fsecret.png')).toThrow();
  });

  it('ISO-18: rejects an empty or null reference', () => {
    expect(() => assertSafeMediaPath('')).toThrow();
    expect(() => assertSafeMediaPath(null)).toThrow();
    expect(() => assertSafeMediaPath(undefined)).toThrow();
  });

  it('ISO-19: the expected object path shape has no client input beyond user_id and a validated sha256', () => {
    const sha = 'a'.repeat(64);
    expect(expectedObjectPath('user-123', sha)).toBe(`user-123/${sha}.png`);
    expect(() => expectedObjectPath('user-123', 'not-a-hash')).toThrow();
  });

  it('localCachePath derives the filename rather than trusting the full remote path', () => {
    expect(localCachePath('u1', `u1/${'b'.repeat(64)}.png`)).toBe(`images/u1/${'b'.repeat(64)}.png`);
  });

  it('localCachePath rejects a hostile mediaPath before touching the filesystem', () => {
    expect(() => localCachePath('u1', '../u2/secret.png')).toThrow();
  });
});
