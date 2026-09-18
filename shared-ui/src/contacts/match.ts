// Wraps ApiClient.matchContacts with the two client-side guarantees the spec
// calls out (crmex.md §7.4):
//  - the payload sent never carries phone numbers, JIDs or message bodies
//    (NLM-04) — enforced by construction, since ContactIndexEntry has no
//    such fields to begin with (see types.ts). `buildContactIndex` further
//    guards against a caller accidentally spreading a NormalizedContact in.
//  - an id the server returns that wasn't in the submitted index is
//    discarded, never queued (NLM-05).
import type { ApiClient, ContactIndexEntry, NormalizedContact } from '../types.js';

export interface ContactMetaLookup {
  jid: string;
  tags?: string[];
  notes?: string;
  lastContactAt?: string;
}

/** Builds the compact index sent for matching. Deliberately whitelists
 * fields rather than spreading a contact object, so a new field added to
 * NormalizedContact (e.g. a raw phone number) can never leak into the index
 * by accident. */
export function buildContactIndex(contacts: NormalizedContact[], meta: ContactMetaLookup[]): ContactIndexEntry[] {
  const metaByJid = new Map(meta.map((m) => [m.jid, m]));
  return contacts.map((c) => {
    const m = metaByJid.get(c.jid);
    return {
      id: c.id,
      displayName: c.displayName,
      tags: m?.tags,
      notes: m?.notes,
      lastContactAt: m?.lastContactAt,
    };
  });
}

export interface MatchOutcome {
  matched: NormalizedContact[];
  /** ids the server returned that weren't in the submitted index — dropped, never queued (NLM-05). */
  discardedIds: string[];
}

/**
 * Runs the NL match and returns a *selection for confirmation only*
 * (NLM-03) — this function never queues or sends anything; it is the
 * caller's job to route the result through a confirmation UI before it can
 * reach `buildQueue`.
 */
export async function matchContactsForConfirmation(
  api: ApiClient,
  query: string,
  contacts: NormalizedContact[],
  index: ContactIndexEntry[],
): Promise<MatchOutcome> {
  const indexIds = new Set(index.map((e) => e.id));
  const matchedIds = await api.matchContacts(query, index);

  const byId = new Map(contacts.map((c) => [c.id, c]));
  const matched: NormalizedContact[] = [];
  const discardedIds: string[] = [];

  for (const id of matchedIds) {
    if (!indexIds.has(id)) {
      discardedIds.push(id); // NLM-05: not in the index we submitted — discard
      continue;
    }
    const contact = byId.get(id);
    if (contact) matched.push(contact);
  }

  return { matched, discardedIds };
}
