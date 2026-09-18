import { useEffect, useState } from 'react';
import { toCountryCode } from '../../contacts/regionResolver.js';
import type { CountryCode } from '../../types.js';
import type { KeyValueStore, PlatformServices } from '../platform.js';

const KEY = 'contacts.regionOverride';

export async function loadRegionOverride(prefs: KeyValueStore): Promise<CountryCode | null> {
  const value = await prefs.get(KEY).catch(() => null);
  return value ? toCountryCode(value) : null;
}

export async function saveRegionOverride(prefs: KeyValueStore, region: CountryCode | null): Promise<void> {
  if (region) await prefs.set(KEY, region);
  else await prefs.remove(KEY);
}

/** Default region for typed/imported phone numbers: the user's override, else the platform's SIM/locale guess. */
export async function resolveAppRegion(platform: PlatformServices): Promise<CountryCode> {
  return platform.resolveRegion(await loadRegionOverride(platform.preferences));
}

export function useRegion(platform: PlatformServices): CountryCode | null {
  const [region, setRegion] = useState<CountryCode | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolveAppRegion(platform)
      .then((r) => !cancelled && setRegion(r))
      .catch(() => !cancelled && setRegion('US'));
    return () => {
      cancelled = true;
    };
  }, [platform]);
  return region;
}
