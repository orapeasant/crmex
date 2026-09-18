// crmex.md §7.2: default to SIM region, user-overridable, falling back to
// locale when SIM region is unavailable (no first-party Capacitor API for
// it — crmex.md §14 open item). Pure precedence logic, unit-testable
// (PHN-08) independent of the actual TelephonyManager/Device plugin calls.
import { getCountries } from 'libphonenumber-js';
import type { CountryCode } from '../types.js';

const HARD_DEFAULT_REGION: CountryCode = 'US';
const VALID_REGIONS = new Set<string>(getCountries());

/**
 * Validates an untyped region string from a native plugin (SIM country ISO,
 * locale region subtag — both plain `string` at the OS boundary) against
 * libphonenumber-js's known region codes, returning null rather than
 * silently casting an invalid/garbage value that would otherwise flow into
 * parsePhoneNumberFromString and produce confusing results.
 */
export function toCountryCode(value: string | null | undefined): CountryCode | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return VALID_REGIONS.has(upper) ? (upper as CountryCode) : null;
}

export interface RegionInputs {
  userOverride: CountryCode | null;
  simRegion: CountryCode | null;
  localeRegion: CountryCode | null;
}

export function resolveDefaultRegion(inputs: RegionInputs): CountryCode {
  return inputs.userOverride ?? inputs.simRegion ?? inputs.localeRegion ?? HARD_DEFAULT_REGION;
}
