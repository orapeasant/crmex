import type { GeneratedImage, ImageGenProvider, PromptHistoryEntry } from '../types';
import { editViaFallbackGenerate } from './editFallback';
import { createHash } from 'crypto';

function pngFor(seed: string): Buffer {
  // Not a real PNG — deterministic bytes derived from the seed, sufficient
  // for hashing/storage-path tests. Real content correctness ("is the image
  // good") is explicitly out of scope per test-plan.md.
  return Buffer.concat([Buffer.from('FAKEPNG:'), createHash('sha256').update(seed).digest()]);
}

export interface FakeImageGenOptions {
  onGenerate?: (prompt: string) => void;
  onEdit?: (instruction: string) => void;
  failWith?: Error;
  /** When true, edit() always falls back to generate() (IMG-04). */
  noEditEndpoint?: boolean;
}

export function createFakeImageGenProvider(opts: FakeImageGenOptions = {}): ImageGenProvider & {
  generateCalls: string[];
  editCalls: string[];
} {
  const generateCalls: string[] = [];
  const editCalls: string[] = [];

  async function generate(prompt: string): Promise<GeneratedImage> {
    generateCalls.push(prompt);
    opts.onGenerate?.(prompt);
    if (opts.failWith) throw opts.failWith;
    return { bytes: pngFor(prompt), mimeType: 'image/png' };
  }

  async function edit(
    baseImage: Buffer,
    instruction: string,
    history: Pick<PromptHistoryEntry, 'prompt'>[] = [{ prompt: 'base' }],
  ): Promise<GeneratedImage> {
    editCalls.push(instruction);
    opts.onEdit?.(instruction);
    if (opts.failWith) throw opts.failWith;
    if (opts.noEditEndpoint) {
      // Exercised directly by IMG-04's unit test too, but wiring it here
      // means the fake behaves like a real no-edit-endpoint vendor end to end.
      return editViaFallbackGenerate(generate, history, instruction);
    }
    return { bytes: pngFor(`${baseImage.toString('hex').slice(0, 16)}:${instruction}`), mimeType: 'image/png' };
  }

  return { generate, edit, generateCalls, editCalls };
}
