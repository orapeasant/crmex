import type { LlmProvider } from '../providers/types';

export const MAX_DRAFT_CHARS = 1000;

const SYSTEM_PROMPT = [
  'You write short WhatsApp messages on behalf of the user.',
  'Reply with the message text only: no preamble, no quotation marks, no explanation, no placeholders like [Name].',
  'Keep it natural and concise (at most a few sentences) unless the user asks for something longer.',
  'Match the language and tone the user asks for.',
].join(' ');

/**
 * Drafts message text from the user's description. The request carries only
 * the user's own prompt — no contacts, numbers or history reach the LLM.
 */
export async function draftMessage(llm: LlmProvider, prompt: string): Promise<{ text: string }> {
  const raw = await llm.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);
  const text = raw
    .trim()
    // Strip one wrapping pair of quotes only when no other quote is inside —
    // otherwise `"Hi" and "bye"` would lose its outer quotes and break.
    .replace(/^["“]([^"“”]*)["”]$/, '$1')
    .trim()
    .slice(0, MAX_DRAFT_CHARS);
  if (!text) throw new Error('The model returned an empty draft');
  return { text };
}
