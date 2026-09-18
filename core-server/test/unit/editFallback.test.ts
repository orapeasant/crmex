import { describe, expect, it } from 'vitest';
import { amendPromptFromHistory, editViaFallbackGenerate } from '../../src/providers/image-gen/editFallback';
import { createFakeImageGenProvider } from '../../src/providers/image-gen/fake';

describe('providers/image-gen/editFallback', () => {
  it('amends a prompt from prior history plus the new instruction', () => {
    const amended = amendPromptFromHistory([{ prompt: 'a red bicycle' }], 'make it blue');
    expect(amended).toBe('a red bicycle. Refinement: make it blue');
  });

  it('falls back to an amended generate() when there is no history yet', async () => {
    const generate = async (prompt: string) => ({ bytes: Buffer.from(prompt), mimeType: 'image/png' });
    const result = await editViaFallbackGenerate(generate, [], 'add a hat');
    expect(result.bytes.toString()).toBe('add a hat');
  });

  it('IMG-04: a provider with no edit endpoint falls back to generate(); the caller sees the same GeneratedImage shape', async () => {
    const provider = createFakeImageGenProvider({ noEditEndpoint: true });
    const base = Buffer.from('irrelevant-base-image-bytes');

    const result = await provider.edit(base, 'make it festive');

    // Caller-visible contract is identical to a "real" edit response.
    expect(Buffer.isBuffer(result.bytes)).toBe(true);
    expect(result.mimeType).toBe('image/png');
    // Internally, this went through generate() rather than a true edit call.
    expect(provider.generateCalls.length).toBe(1);
    expect(provider.editCalls).toEqual(['make it festive']);
  });
});
