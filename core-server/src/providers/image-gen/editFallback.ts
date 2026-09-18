import type { PromptHistoryEntry } from '../types';

/**
 * Amends a prompt from session history plus a free-text refinement
 * instruction. Used by ImageGenProvider.edit() implementations for vendors
 * whose edit/inpaint endpoint can't cleanly take "prior image + plain
 * instruction" (crmex.md §6, test-plan.md IMG-04).
 */
export function amendPromptFromHistory(
  history: Pick<PromptHistoryEntry, 'prompt'>[],
  instruction: string,
): string {
  const base = history.map((h) => h.prompt.trim()).filter(Boolean).join('; ');
  if (!base) return instruction.trim();
  return `${base}. Refinement: ${instruction.trim()}`;
}

/**
 * Generic edit-via-fallback-generate: call this from an ImageGenProvider's
 * edit() when the vendor has no true edit endpoint (or it doesn't fit the
 * "plain instruction + prior image" shape). The caller (imageAgent) sees no
 * difference between this and a true edit — same GeneratedImage shape.
 */
export async function editViaFallbackGenerate(
  generate: (prompt: string) => Promise<{ bytes: Buffer; mimeType: string }>,
  history: Pick<PromptHistoryEntry, 'prompt'>[],
  instruction: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const amended = amendPromptFromHistory(history, instruction);
  return generate(amended);
}
