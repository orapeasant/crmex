import { describe, it, expect } from 'vitest';
import { resolveDefaultRegion } from './regionResolver.js';

describe('resolveDefaultRegion (PHN-08)', () => {
  it('prefers the user override when set', () => {
    expect(resolveDefaultRegion({ userOverride: 'FR', simRegion: 'EG', localeRegion: 'US' })).toBe('FR');
  });

  it('falls back to SIM region when no override', () => {
    expect(resolveDefaultRegion({ userOverride: null, simRegion: 'EG', localeRegion: 'US' })).toBe('EG');
  });

  it('falls back to locale region when SIM region is unavailable', () => {
    expect(resolveDefaultRegion({ userOverride: null, simRegion: null, localeRegion: 'US' })).toBe('US');
  });

  it('falls back to a hard default when nothing is available', () => {
    expect(resolveDefaultRegion({ userOverride: null, simRegion: null, localeRegion: null })).toBe('US');
  });
});
