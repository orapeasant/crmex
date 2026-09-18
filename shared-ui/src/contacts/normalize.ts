// Real E.164 normalization per crmex.md §7.2. This is the corrected version —
// the previous draft only stripped non-digits, which silently produces wrong
// numbers. Region-aware parsing via libphonenumber-js is required.
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { NormalizedContact, NeedsReviewContact } from '../types.js';

export interface RawContact {
  contactId: string;
  displayName: string | null | undefined;
  phones: string[];
}

export interface NormalizeResult {
  usable: NormalizedContact[];
  needsReview: NeedsReviewContact[];
}

/**
 * Derive a WhatsApp JID from an E.164 number. `e164` MUST already carry a
 * single leading '+' (guaranteed by libphonenumber-js's `.number`).
 * Uses `.slice(1)` rather than `.replace('+', '')` — replace() only removes
 * the *first* occurrence, which is fragile even though it happens to be
 * correct here (crmex.md §7.2, PHN-07).
 */
export function jidFromE164(e164: string): string {
  if (!e164.startsWith('+')) {
    throw new Error(`jidFromE164: expected a '+'-prefixed E.164 string, got ${e164}`);
  }
  return `${e164.slice(1)}@s.whatsapp.net`;
}

/**
 * Normalize a single raw phone-number string against a default region.
 * Returns null if the number cannot be parsed into a valid number for any
 * region (PHN-05, PHN-06) — callers route those to `needsReview`.
 */
export function normalizeOne(raw: string, defaultRegion: CountryCode): string | null {
  if (!raw) return null;
  const parsed = parsePhoneNumberFromString(raw, defaultRegion);
  if (parsed?.isValid()) {
    return parsed.number; // always '+<digits>'
  }
  return null;
}

/**
 * Normalize a full raw contact list. Considers ALL of a contact's numbers,
 * not just phones[0] (crmex.md §7.2 correction). Contacts with no phone
 * numbers at all are excluded from both buckets (CON-04).
 */
export function normalizeContacts(raw: RawContact[], defaultRegion: CountryCode): NormalizeResult {
  const usable: NormalizedContact[] = [];
  const needsReview: NeedsReviewContact[] = [];

  for (const c of raw) {
    const displayName = c.displayName?.trim() || 'Unknown Contact';
    for (const phone of c.phones ?? []) {
      const rawNumber = phone ?? '';
      if (!rawNumber) continue;
      const e164 = normalizeOne(rawNumber, defaultRegion);
      if (e164) {
        usable.push({
          id: `${c.contactId}:${e164}`,
          displayName,
          e164,
          jid: jidFromE164(e164),
        });
      } else {
        needsReview.push({ id: c.contactId, displayName, raw: rawNumber });
      }
    }
  }

  return { usable, needsReview };
}

/**
 * PHN-09: when the user changes their region override, previously
 * `needsReview` numbers must be re-evaluated against the new region rather
 * than staying stuck in the review bucket forever.
 */
export function reEvaluateNeedsReview(
  needsReview: NeedsReviewContact[],
  newRegion: CountryCode,
): NormalizeResult {
  const usable: NormalizedContact[] = [];
  const stillNeedsReview: NeedsReviewContact[] = [];

  for (const item of needsReview) {
    const e164 = normalizeOne(item.raw, newRegion);
    if (e164) {
      usable.push({
        id: `${item.id}:${e164}`,
        displayName: item.displayName,
        e164,
        jid: jidFromE164(e164),
      });
    } else {
      stillNeedsReview.push(item);
    }
  }

  return { usable, needsReview: stillNeedsReview };
}
