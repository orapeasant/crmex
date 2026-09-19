// Pure client-list logic: filtering, tags, recipient derivation, import planning.
import { jidFromE164, normalizeOne } from '../contacts/normalize.js';
import type { CountryCode, NormalizedContact } from '../types.js';
import type { ClientKind, ClientRow } from './types.js';

export interface ClientFilter {
  query?: string;
  kind?: ClientKind | null;
  tag?: string | null;
}

export function filterClients(clients: ClientRow[], filter: ClientFilter): ClientRow[] {
  const q = (filter.query ?? '').trim().toLowerCase();
  const digits = q.replace(/[^0-9]/g, '');
  return clients.filter((c) => {
    if (filter.kind && c.kind !== filter.kind) return false;
    if (filter.tag && !(c.tags ?? []).includes(filter.tag)) return false;
    if (!q) return true;
    return (
      c.display_name.toLowerCase().includes(q) ||
      (c.email ?? '').toLowerCase().includes(q) ||
      (digits.length >= 3 && (c.phone_e164 ?? '').includes(digits)) ||
      (c.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });
}

/** Distinct tags across clients, most used first then alphabetical. */
export function collectTags(clients: ClientRow[]): string[] {
  const counts = new Map<string, number>();
  for (const c of clients) for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
}

/** Parse a comma-separated tag string into a clean, de-duplicated list. */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const t = raw.trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export interface RecipientContact extends NormalizedContact {
  clientId: string;
}

export interface ClientRecipients {
  recipients: RecipientContact[];
  /** Clients hidden because they opted out of messages. */
  suppressedCount: number;
  /** Clients without a usable phone number. */
  noPhoneCount: number;
  /** Clients hidden because they are not `active` (crmex.md §18.3.1) — inactive or archived. */
  inactiveCount: number;
}

/**
 * Firm clients that may be offered as message recipients: `active`, a valid
 * E.164 phone, and not suppressed (crmex.md §18.3.1, §18.4 step 2). Inactive
 * and archived clients are never offered at all, distinct from suppression —
 * a client can be active and opted out, or inactive and never opted out —
 * so each is counted separately rather than merged into one number. A client who
 * is both counts once, as opted out. Both are re-checked at send/claim time.
 */
export function clientRecipients(clients: ClientRow[]): ClientRecipients {
  const recipients: RecipientContact[] = [];
  let suppressedCount = 0;
  let noPhoneCount = 0;
  let inactiveCount = 0;
  for (const c of clients) {
    // Suppression is checked BEFORE status, so a client who is both opted out and
    // inactive is reported as opted out. Two reasons, one label: the opt-out is the
    // durable fact about the person, while the status is the firm's own filing that
    // staff can undo. Labelling such a client "inactive" invites the reader to
    // reactivate them and expect the message to go — it will not, because
    // suppression blocks it independently. queueSendJob and the claim-time re-check
    // in jobRunner order these the same way; all three must agree or the wizard and
    // the queued result will name different reasons for the same person.
    if (c.suppressed_at) {
      suppressedCount++;
      continue;
    }
    if (c.status !== 'active') {
      inactiveCount++;
      continue;
    }
    const e164 = c.phone_e164 && /^\+[1-9][0-9]{6,14}$/.test(c.phone_e164) ? c.phone_e164 : null;
    if (!e164) {
      noPhoneCount++;
      continue;
    }
    recipients.push({ id: c.id, clientId: c.id, displayName: c.display_name, e164, jid: jidFromE164(e164) });
  }
  recipients.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { recipients, suppressedCount, noPhoneCount, inactiveCount };
}

/** JIDs of the firm's suppressed clients — the suppression list buildQueue enforces. */
export function suppressedJidsOf(clients: Pick<ClientRow, 'phone_e164' | 'suppressed_at'>[]): Set<string> {
  const out = new Set<string>();
  for (const c of clients) {
    if (c.suppressed_at && c.phone_e164 && c.phone_e164.startsWith('+')) out.add(jidFromE164(c.phone_e164));
  }
  return out;
}

export type PhoneCheck = { ok: true; e164: string | null } | { ok: false; error: string };

/** Normalize a typed phone number for a client record. Empty is allowed (no phone). */
export function checkClientPhone(raw: string, region: CountryCode): PhoneCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, e164: null };
  const e164 = normalizeOne(trimmed, region);
  if (!e164) return { ok: false, error: `Not a valid phone number for region ${region}. Include the country code, e.g. +65 9123 4567.` };
  return { ok: true, e164 };
}

export interface ImportPlan {
  toInsert: { display_name: string; phone_e164: string }[];
  alreadyClients: NormalizedContact[];
  duplicates: NormalizedContact[];
}

/** Dedupe selected phone contacts against the firm's existing phones and within the selection. */
export function planClientImport(existingPhones: Iterable<string | null>, selected: NormalizedContact[]): ImportPlan {
  const existing = new Set<string>();
  for (const p of existingPhones) if (p) existing.add(p);
  const seen = new Set<string>();
  const plan: ImportPlan = { toInsert: [], alreadyClients: [], duplicates: [] };
  for (const c of selected) {
    if (existing.has(c.e164)) {
      plan.alreadyClients.push(c);
    } else if (seen.has(c.e164)) {
      plan.duplicates.push(c);
    } else {
      seen.add(c.e164);
      plan.toInsert.push({ display_name: c.displayName.trim().slice(0, 200) || c.e164, phone_e164: c.e164 });
    }
  }
  return plan;
}

export function clientKindLabel(kind: ClientKind): string {
  switch (kind) {
    case 'client':
      return 'Client';
    case 'prospect':
      return 'Prospect';
    case 'opposing_counsel':
      return 'Opposing counsel';
    case 'court':
      return 'Court';
    default:
      return 'Other';
  }
}
