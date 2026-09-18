// Thin registerPlugin() wrapper for the custom SimRegionPlugin.java
// (crmex.md §7.2, §14). See android/app/src/main/java/com/crmex/gateway/SimRegionPlugin.java.
import { registerPlugin } from '@capacitor/core';

export interface SimRegionApi {
  getSimCountryIso(): Promise<{ region: string | null }>;
}

export const SimRegion = registerPlugin<SimRegionApi>('SimRegion');
