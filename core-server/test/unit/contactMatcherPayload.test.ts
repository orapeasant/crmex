import { describe, expect, it } from 'vitest';
import { buildAllowlistedIndex, matchContacts } from '../../src/agent/contactMatcher';
import { createFakeLlmProvider } from '../../src/providers/llm/fake';

describe('agent/contactMatcher payload allow-listing', () => {
  it('NLM-04: the payload sent to the LLM contains no phone numbers, JIDs or message bodies', async () => {
    const hostileIndex = [
      {
        id: 'c1',
        displayName: 'Alice',
        tags: ['vip'],
        notes: 'met at conference',
        lastContactAt: '2026-01-01T00:00:00.000Z',
        // Fields that must never reach the LLM, even though a careless or
        // hostile client might include them on the wire:
        phone: '+15550001111',
        e164: '+15550001111',
        jid: '15550001111@s.whatsapp.net',
        body: 'Secret message body that must not leak',
      } as any,
    ];

    const llm = createFakeLlmProvider({ chatResponse: () => '["c1"]' });
    await matchContacts(llm, 'my VIP contacts', hostileIndex);

    expect(llm.calls.length).toBe(1);
    const serialized = JSON.stringify(llm.calls[0]);
    expect(serialized).not.toContain('+15550001111');
    expect(serialized).not.toContain('s.whatsapp.net');
    expect(serialized).not.toContain('Secret message body');
    // What SHOULD be present: the allow-listed fields.
    expect(serialized).toContain('Alice');
    expect(serialized).toContain('vip');
  });

  it('buildAllowlistedIndex only ever emits the five allow-listed fields', () => {
    const out = buildAllowlistedIndex([{ id: 'c1', displayName: 'Bob', phone: '+1', jid: 'x@y' } as any]);
    expect(Object.keys(out[0]).sort()).toEqual(['displayName', 'id', 'lastContactAt', 'notes', 'tags'].sort());
  });

  it('NLM-05: discards an id the LLM returns that was not present in the submitted index', async () => {
    const llm = createFakeLlmProvider({ chatResponse: () => '["c1", "c-does-not-exist"]' });
    const result = await matchContacts(llm, 'anyone', [{ id: 'c1', displayName: 'Alice' }]);
    expect(result.matchedIds).toEqual(['c1']);
  });

  it('NLM-05: tolerates a non-JSON or garbage LLM response by returning no matches rather than throwing', async () => {
    const llm = createFakeLlmProvider({ chatResponse: () => 'I think the answer is... nothing really' });
    const result = await matchContacts(llm, 'anyone', [{ id: 'c1', displayName: 'Alice' }]);
    expect(result.matchedIds).toEqual([]);
  });
});
