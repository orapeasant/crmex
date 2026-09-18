import { describe, it, expect } from 'vitest';
import { parseInviteToken, describeInviteError } from './invite.js';
import { checkClientPhone, clientRecipients, collectTags, filterClients, parseTags, planClientImport, suppressedJidsOf } from './clients.js';
import { dueAtFromParts, duePartsFromIso, formatDue, groupTasks } from './tasks.js';
import { groupHistoryBatches } from './history.js';
import type { ClientRow, TaskRow } from './types.js';
import type { MessageHistoryRow } from '../supabase/repo.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'; // 42 chars, base64url

function clientRow(over: Partial<ClientRow>): ClientRow {
  return {
    id: 'c1',
    org_id: 'org-a',
    created_by: 'u1',
    display_name: 'Client',
    phone_e164: null,
    email: null,
    kind: 'client',
    tags: [],
    notes: null,
    opted_in_at: null,
    suppressed_at: null,
    source: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function task(over: Partial<TaskRow>): TaskRow {
  return {
    id: 't',
    org_id: 'org-a',
    created_by: 'u1',
    title: 'Task',
    notes: null,
    kind: 'task',
    status: 'open',
    due_at: null,
    matter_id: null,
    assignee_id: null,
    completed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('parseInviteToken', () => {
  it('accepts a bare token, the app link and the browser route', () => {
    expect(parseInviteToken(TOKEN)).toBe(TOKEN);
    expect(parseInviteToken(`  crmex://invite/${TOKEN}  `)).toBe(TOKEN);
    expect(parseInviteToken(`https://app.example.com/invite/${TOKEN}`)).toBe(TOKEN);
  });

  it('rejects wrong charsets, lengths, hosts and paths', () => {
    expect(parseInviteToken('')).toBeNull();
    expect(parseInviteToken(null)).toBeNull();
    expect(parseInviteToken('short')).toBeNull();
    expect(parseInviteToken(`${TOKEN}!`)).toBeNull();
    expect(parseInviteToken('a'.repeat(129))).toBeNull();
    expect(parseInviteToken(`crmex://join/${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`crmex://invite/${TOKEN}/extra`)).toBeNull();
    expect(parseInviteToken(`javascript:alert(1)//${TOKEN}`)).toBeNull();
    expect(parseInviteToken(`https://x.test/other/${TOKEN}`)).toBeNull();
  });

  it('maps accept error codes to readable messages', () => {
    expect(describeInviteError('INVITATION_INVALID', 'x')).toMatch(/invalid/);
    expect(describeInviteError('INVITATION_EMAIL_MISMATCH', 'x')).toMatch(/different email/);
    expect(describeInviteError('OTHER', 'fallback')).toBe('fallback');
  });
});

describe('client helpers', () => {
  const clients = [
    clientRow({ id: 'a', display_name: 'Alice Tan', kind: 'client', tags: ['vip', 'family'], phone_e164: '+6591234567' }),
    clientRow({ id: 'b', display_name: 'Bob Lee', kind: 'prospect', tags: ['family'], email: 'bob@example.com' }),
    clientRow({ id: 'c', display_name: 'Court of Appeal', kind: 'court' }),
  ];

  it('filters by query (name, email, phone digits, tag), kind and tag', () => {
    expect(filterClients(clients, { query: 'ali' }).map((c) => c.id)).toEqual(['a']);
    expect(filterClients(clients, { query: 'bob@' }).map((c) => c.id)).toEqual(['b']);
    expect(filterClients(clients, { query: '9123' }).map((c) => c.id)).toEqual(['a']);
    expect(filterClients(clients, { kind: 'court' }).map((c) => c.id)).toEqual(['c']);
    expect(filterClients(clients, { tag: 'family' }).map((c) => c.id)).toEqual(['a', 'b']);
    expect(filterClients(clients, { tag: 'family', kind: 'prospect' }).map((c) => c.id)).toEqual(['b']);
  });

  it('collects tags by frequency and parses tag input', () => {
    expect(collectTags(clients)).toEqual(['family', 'vip']);
    expect(parseTags(' vip, Family ,, vip,  new   client ')).toEqual(['vip', 'Family', 'new client']);
  });

  it('derives recipients: excludes suppressed and phoneless clients up front', () => {
    const res = clientRecipients([
      ...clients,
      clientRow({ id: 'd', display_name: 'Dan', phone_e164: '+6598765432', suppressed_at: '2026-02-01T00:00:00Z' }),
      clientRow({ id: 'e', display_name: 'Eve', phone_e164: 'garbage' }),
    ]);
    expect(res.recipients).toEqual([{ id: 'a', clientId: 'a', displayName: 'Alice Tan', e164: '+6591234567', jid: '6591234567@s.whatsapp.net' }]);
    expect(res.suppressedCount).toBe(1);
    expect(res.noPhoneCount).toBe(3);
  });

  it('builds the suppression jid set from suppressed_at', () => {
    const set = suppressedJidsOf([
      { phone_e164: '+6591234567', suppressed_at: '2026-02-01T00:00:00Z' },
      { phone_e164: '+6598765432', suppressed_at: null },
      { phone_e164: null, suppressed_at: '2026-02-01T00:00:00Z' },
    ]);
    expect(Array.from(set)).toEqual(['6591234567@s.whatsapp.net']);
  });

  it('normalizes typed phone numbers against the region', () => {
    expect(checkClientPhone('9123 4567', 'SG')).toEqual({ ok: true, e164: '+6591234567' });
    expect(checkClientPhone('', 'SG')).toEqual({ ok: true, e164: null });
    expect(checkClientPhone('12', 'SG').ok).toBe(false);
  });

  it('plans an import: dedupes against existing phones and within the selection', () => {
    const plan = planClientImport(
      ['+6591234567', null],
      [
        { id: '1:+6591234567', displayName: 'Alice', e164: '+6591234567', jid: '6591234567@s.whatsapp.net' },
        { id: '2:+6598765432', displayName: 'Bob', e164: '+6598765432', jid: '6598765432@s.whatsapp.net' },
        { id: '3:+6598765432', displayName: 'Bobby', e164: '+6598765432', jid: '6598765432@s.whatsapp.net' },
      ],
    );
    expect(plan.toInsert).toEqual([{ display_name: 'Bob', phone_e164: '+6598765432' }]);
    expect(plan.alreadyClients.map((c) => c.displayName)).toEqual(['Alice']);
    expect(plan.duplicates.map((c) => c.displayName)).toEqual(['Bobby']);
  });
});

describe('task helpers', () => {
  const now = new Date(2026, 8, 13, 10, 0, 0); // 13 Sep 2026 10:00 local

  it('groups into overdue / today / upcoming / no date / done', () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h, 0, 0).toISOString();
    const s = groupTasks(
      [
        task({ id: 'past', due_at: at(12, 9) }),
        task({ id: 'earlier-today', due_at: at(13, 9) }),
        task({ id: 'later-today', due_at: at(13, 15) }),
        task({ id: 'tomorrow', due_at: at(14, 9) }),
        task({ id: 'nodate' }),
        task({ id: 'done', status: 'done', due_at: at(1, 9), completed_at: at(2, 9) }),
      ],
      now,
    );
    expect(s.overdue.map((t) => t.id)).toEqual(['past', 'earlier-today']);
    expect(s.today.map((t) => t.id)).toEqual(['later-today']);
    expect(s.upcoming.map((t) => t.id)).toEqual(['tomorrow']);
    expect(s.noDate.map((t) => t.id)).toEqual(['nodate']);
    expect(s.done.map((t) => t.id)).toEqual(['done']);
  });

  it('round-trips due dates, treating a date without time as end of day', () => {
    const dateOnly = dueAtFromParts('2026-09-20', '');
    expect(duePartsFromIso(dateOnly)).toEqual({ date: '2026-09-20', time: '' });
    const timed = dueAtFromParts('2026-09-20', '14:30');
    expect(duePartsFromIso(timed)).toEqual({ date: '2026-09-20', time: '14:30' });
    expect(dueAtFromParts('', '10:00')).toBeNull();
    expect(formatDue(dueAtFromParts('2026-09-13', '14:30'), now)).toBe('Today 14:30');
    expect(formatDue(dueAtFromParts('2026-09-14', ''), now)).toBe('Tomorrow');
    expect(formatDue(null, now)).toBe('No date');
  });
});

describe('groupHistoryBatches', () => {
  function h(over: Partial<MessageHistoryRow>): MessageHistoryRow {
    return {
      id: 1,
      org_id: 'org-a',
      user_id: 'u1',
      jid: 'x@s.whatsapp.net',
      display_name: null,
      body: 'hello',
      media_path: null,
      media_sha256: null,
      status: 'SENT',
      error_reason: null,
      batch_id: 'b1',
      client_id: null,
      created_at: '2026-09-01T10:00:00Z',
      resolved_at: null,
      ...over,
    };
  }

  it('summarises per batch with counts, newest batch first', () => {
    const batches = groupHistoryBatches([
      h({ batch_id: 'b1', status: 'SENT', created_at: '2026-09-01T10:00:05Z' }),
      h({ batch_id: 'b1', status: 'FAILED', created_at: '2026-09-01T10:00:00Z' }),
      h({ batch_id: 'b2', status: 'SKIPPED', created_at: '2026-09-02T10:00:00Z', user_id: 'u2' }),
    ]);
    expect(batches.map((b) => b.batchId)).toEqual(['b2', 'b1']);
    expect(batches[1]).toMatchObject({ total: 2, sent: 1, failed: 1, skipped: 0, startedAt: '2026-09-01T10:00:00Z' });
    expect(batches[0]).toMatchObject({ senderId: 'u2', skipped: 1 });
  });
});
