import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import {
  createDraftLlmProvider,
  createImageGenProvider,
  createImageSearchProvider,
  createLlmProvider,
} from '../../src/providers/factory';
import { DEFAULT_DRAFT_MODEL } from '../../src/providers/llm/anthropic';
import { shouldFallBackToGenerate } from '../../src/providers/image-gen/openai';

describe('providers/factory', () => {
  it('selects the fake LLM provider when LLM_PROVIDER=fake, with no key required', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'fake' });
    expect(typeof provider.chat).toBe('function');
  });

  it('defaults to fake when no provider env vars are set at all', () => {
    expect(() => createLlmProvider({})).not.toThrow();
    expect(() => createImageGenProvider({})).not.toThrow();
    expect(() => createImageSearchProvider({})).not.toThrow();
  });

  it('throws a clear error selecting anthropic without an API key', () => {
    expect(() => createLlmProvider({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws a clear error selecting openai without an API key', () => {
    expect(() => createImageGenProvider({ IMAGE_GEN_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
  });

  it('throws a clear error selecting unsplash without an API key', () => {
    expect(() => createImageSearchProvider({ IMAGE_SEARCH_PROVIDER: 'unsplash' })).toThrow(/UNSPLASH_ACCESS_KEY/);
  });

  it('constructs a real anthropic provider given a key, without making a network call', () => {
    const provider = createLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' });
    expect(typeof provider.chat).toBe('function');
    expect(typeof provider.agentTurn).toBe('function');
  });

  it('constructs a real openai image-gen provider given a key, without making a network call', () => {
    const provider = createImageGenProvider({ IMAGE_GEN_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-not-real' });
    expect(typeof provider.generate).toBe('function');
    expect(typeof provider.edit).toBe('function');
  });

  it('constructs a real unsplash provider given a key, without making a network call', () => {
    const provider = createImageSearchProvider({ IMAGE_SEARCH_PROVIDER: 'unsplash', UNSPLASH_ACCESS_KEY: 'test-key' });
    expect(typeof provider.search).toBe('function');
  });

  it('rejects an unknown provider name', () => {
    expect(() => createLlmProvider({ LLM_PROVIDER: 'not-a-real-provider' })).toThrow(/Unknown LLM_PROVIDER/);
  });

  it('builds a draft LLM provider with the same vendor selection and key requirement', () => {
    expect(typeof createDraftLlmProvider({ LLM_PROVIDER: 'fake' }).chat).toBe('function');
    expect(() => createDraftLlmProvider({ LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(typeof createDraftLlmProvider({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-test-not-real' }).chat).toBe('function');
  });

  it('drafting defaults to a Haiku-class model', () => {
    expect(DEFAULT_DRAFT_MODEL).toMatch(/haiku/);
  });
});

describe('providers/image-gen/openai edit fallback policy', () => {
  const apiError = (status: number) => OpenAI.APIError.generate(status, { error: { message: 'x' } }, 'x', {});

  it('falls back to generate() only when the edit request was rejected or returned no data', () => {
    expect(shouldFallBackToGenerate(apiError(400))).toBe(true);
    expect(shouldFallBackToGenerate(apiError(404))).toBe(true);
    expect(shouldFallBackToGenerate(new Error('OpenAI image edit returned no image data'))).toBe(true);
  });

  it('does not fall back on auth, rate-limit/billing, server or network errors', () => {
    expect(shouldFallBackToGenerate(apiError(401))).toBe(false);
    expect(shouldFallBackToGenerate(apiError(429))).toBe(false);
    expect(shouldFallBackToGenerate(apiError(500))).toBe(false);
    expect(shouldFallBackToGenerate(new Error('socket hang up'))).toBe(false);
  });
});
