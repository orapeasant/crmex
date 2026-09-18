import { describe, it, expect, vi } from 'vitest';
import { buildContactIndex, matchContactsForConfirmation } from './match.js';
import type { ApiClient, NormalizedContact } from '../types.js';

const alice: NormalizedContact = { id: 'c1', displayName: 'Alice', e164: '+201001234567', jid: '201001234567@s.whatsapp.net' };
const bob: NormalizedContact = { id: 'c2', displayName: 'Bob', e164: '+201111234567', jid: '201111234567@s.whatsapp.net' };

describe('buildContactIndex (NLM-04)', () => {
  it('never includes phone numbers or jids in the index sent to the server', () => {
    const index = buildContactIndex([alice], [{ jid: alice.jid, tags: ['vip'] }]);
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain(alice.e164);
    expect(serialized).not.toContain(alice.jid);
    expect(index[0]).toEqual({ id: 'c1', displayName: 'Alice', tags: ['vip'], notes: undefined, lastContactAt: undefined });
  });
});

describe('matchContactsForConfirmation (NLM-03, NLM-05)', () => {
  it('NLM-05: an id returned by the server that was not in the submitted index is discarded', async () => {
    const api: ApiClient = {
      health: vi.fn(),
      matchContacts: vi.fn(async () => ['c1', 'ghost-id']),
      generateImage: vi.fn(),
      refineImage: vi.fn(),
      searchImages: vi.fn(),
      selectSearchImage: vi.fn(),
    } as unknown as ApiClient;

    const index = buildContactIndex([alice, bob], []);
    const outcome = await matchContactsForConfirmation(api, 'my vip customers', [alice, bob], index);

    expect(outcome.matched).toEqual([alice]);
    expect(outcome.discardedIds).toEqual(['ghost-id']);
  });

  it('NLM-03: matching only returns a selection, never calls anything queue/send related', async () => {
    const matchContacts = vi.fn(async () => ['c1']);
    const api = { matchContacts } as unknown as ApiClient;
    const index = buildContactIndex([alice], []);
    await matchContactsForConfirmation(api, 'message all my customers now', [alice], index);
    // The function's only side effect is the one matchContacts call — no
    // send-related API exists on this surface at all, so there is nothing
    // else it could have called into.
    expect(matchContacts).toHaveBeenCalledTimes(1);
  });
});
