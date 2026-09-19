import OpenAI, { toFile } from 'openai';
import type { GeneratedImage, ImageGenProvider, PromptHistoryEntry } from '../types';
import { editViaFallbackGenerate } from './editFallback';

const DEFAULT_MODEL = 'gpt-image-1';

/**
 * Only fall back when the edit request itself was rejected (model/image
 * not editable: 400/404/422) or returned no data. Auth, rate-limit, 5xx
 * and connection errors would fail generate() the same way — falling back
 * on those just doubles the latency (and possibly the cost) before the
 * caller sees the error.
 */
export function shouldFallBackToGenerate(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    return err.status === 400 || err.status === 404 || err.status === 422;
  }
  return err instanceof Error && /returned no image data/.test(err.message);
}

/**
 * OpenAI-backed ImageGenProvider (crmex.md §6). Never exercised by tests
 * with a real key — tests use providers/image-gen/fake.ts via
 * IMAGE_GEN_PROVIDER=fake.
 *
 * generate() uses images.generate. edit() attempts images.edit (which does
 * accept a source image + a plain-text prompt for gpt-image-1) and falls
 * back to an amended generate() — per crmex.md §6's explicit note that this
 * fallback must be invisible to callers — if the edit call is rejected
 * (vendor/model doesn't support edit, image not editable). This makes the
 * "vendor with no real edit endpoint" case (IMG-04) and "vendor edit
 * endpoint rejects this image" case degrade the same way. The fallback
 * prompt is amended from the session's prompt history, so the regenerated
 * image still reflects the original request, not just the refinement.
 *
 * gpt-image-1 always returns base64 (`b64_json`) and rejects
 * `response_format`, so none is sent; output is PNG by default.
 */
export function createOpenAiImageGenProvider(apiKey: string, model: string = DEFAULT_MODEL, baseURL?: string): ImageGenProvider {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });

  async function generate(prompt: string, opts?: { width?: number; height?: number }): Promise<GeneratedImage> {
    const size = opts?.width && opts?.height ? (`${opts.width}x${opts.height}` as const) : undefined;
    const response = await client.images.generate({
      model,
      prompt,
      size: size as any,
      n: 1,
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI image generation returned no image data');
    return { bytes: Buffer.from(b64, 'base64'), mimeType: 'image/png' };
  }

  async function editViaVendor(baseImage: Buffer, instruction: string): Promise<GeneratedImage> {
    const file = await toFile(baseImage, 'source.png', { type: 'image/png' });
    const response = await client.images.edit({
      model,
      image: file,
      prompt: instruction,
      n: 1,
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI image edit returned no image data');
    return { bytes: Buffer.from(b64, 'base64'), mimeType: 'image/png' };
  }

  async function edit(
    baseImage: Buffer,
    instruction: string,
    history: Pick<PromptHistoryEntry, 'prompt'>[] = [],
  ): Promise<GeneratedImage> {
    try {
      return await editViaVendor(baseImage, instruction);
    } catch (err) {
      if (!shouldFallBackToGenerate(err)) throw err;
      return editViaFallbackGenerate((p) => generate(p), history, instruction);
    }
  }

  return { generate, edit };
}
