import type { ImageGenProvider, ImageSearchProvider, LlmProvider } from './types';
import { createAnthropicLlmProvider, DEFAULT_DRAFT_MODEL } from './llm/anthropic';
import { createFakeLlmProvider } from './llm/fake';
import { createOpenAiImageGenProvider } from './image-gen/openai';
import { createFakeImageGenProvider } from './image-gen/fake';
import { createUnsplashImageSearchProvider } from './image-search/unsplash';
import { createFakeImageSearchProvider } from './image-search/fake';

export interface ProviderEnv {
  LLM_PROVIDER?: string;
  IMAGE_GEN_PROVIDER?: string;
  IMAGE_SEARCH_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Optional gateway URLs (e.g. a LiteLLM proxy); unset means the vendor's default. */
  ANTHROPIC_BASE_URL?: string;
  OPENAI_BASE_URL?: string;
  UNSPLASH_ACCESS_KEY?: string;
  /** Optional model overrides — names only; unset means the adapter's default. */
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_DRAFT_MODEL?: string;
  OPENAI_IMAGE_MODEL?: string;
}

/**
 * Reads LLM_PROVIDER / IMAGE_GEN_PROVIDER / IMAGE_SEARCH_PROVIDER from the
 * environment and returns the configured implementation of each interface
 * (crmex.md §6). "fake" is a valid value for every one of them so a process
 * can run with zero provider keys (used by tests and by `npm start` smoke
 * checks); the HTTP layer never has to know which one it got.
 */
export function createLlmProvider(env: ProviderEnv): LlmProvider {
  const kind = env.LLM_PROVIDER ?? 'fake';
  switch (kind) {
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return createAnthropicLlmProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || undefined, env.ANTHROPIC_BASE_URL || undefined);
    }
    case 'fake':
      return createFakeLlmProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${kind}`);
  }
}

/**
 * Same vendor selection as createLlmProvider, but configured for short-form
 * message drafting: a fast, inexpensive model by default, since drafting is a
 * high-volume, low-difficulty call made on every wizard step.
 */
export function createDraftLlmProvider(env: ProviderEnv): LlmProvider {
  const kind = env.LLM_PROVIDER ?? 'fake';
  switch (kind) {
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
      return createAnthropicLlmProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_DRAFT_MODEL || DEFAULT_DRAFT_MODEL, env.ANTHROPIC_BASE_URL || undefined);
    }
    case 'fake':
      return createFakeLlmProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${kind}`);
  }
}

export function createImageGenProvider(env: ProviderEnv): ImageGenProvider {
  const kind = env.IMAGE_GEN_PROVIDER ?? 'fake';
  switch (kind) {
    case 'openai': {
      if (!env.OPENAI_API_KEY) throw new Error('IMAGE_GEN_PROVIDER=openai requires OPENAI_API_KEY');
      return createOpenAiImageGenProvider(env.OPENAI_API_KEY, env.OPENAI_IMAGE_MODEL || undefined, env.OPENAI_BASE_URL || undefined);
    }
    case 'fake':
      return createFakeImageGenProvider();
    default:
      throw new Error(`Unknown IMAGE_GEN_PROVIDER: ${kind}`);
  }
}

export function createImageSearchProvider(env: ProviderEnv): ImageSearchProvider {
  const kind = env.IMAGE_SEARCH_PROVIDER ?? 'fake';
  switch (kind) {
    case 'unsplash': {
      if (!env.UNSPLASH_ACCESS_KEY) throw new Error('IMAGE_SEARCH_PROVIDER=unsplash requires UNSPLASH_ACCESS_KEY');
      return createUnsplashImageSearchProvider(env.UNSPLASH_ACCESS_KEY);
    }
    case 'fake':
      return createFakeImageSearchProvider();
    default:
      throw new Error(`Unknown IMAGE_SEARCH_PROVIDER: ${kind}`);
  }
}
