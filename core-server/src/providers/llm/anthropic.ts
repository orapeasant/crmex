import Anthropic from '@anthropic-ai/sdk';
import type { AgentTurnResult, ChatMessage, LlmProvider, ToolDef } from '../types';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Fast, inexpensive model for short-form text (message drafting). */
export const DEFAULT_DRAFT_MODEL = 'claude-haiku-4-5';

/**
 * Anthropic-backed LlmProvider (crmex.md §6). Used for contactMatcher's
 * NL -> ranked contact ids. Never called from tests directly — tests use
 * providers/llm/fake.ts via LLM_PROVIDER=fake so the suite has zero network
 * dependency and needs no real key.
 */
export function createAnthropicLlmProvider(apiKey: string, model: string = DEFAULT_MODEL): LlmProvider {
  const client = new Anthropic({ apiKey });

  function splitSystem(messages: ChatMessage[]): { system?: string; rest: Array<{ role: 'user' | 'assistant'; content: string }> } {
    const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    return { system: systemParts.length ? systemParts.join('\n\n') : undefined, rest };
  }

  async function chat(messages: ChatMessage[]): Promise<string> {
    const { system, rest } = splitSystem(messages);
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: rest.length > 0 ? rest : [{ role: 'user', content: '' }],
    });
    // stop_reason is typed as a closed union in this SDK version, but newer
    // API values (e.g. 'refusal') can still arrive — compare as a string.
    if ((response.stop_reason as string) === 'refusal') {
      throw new Error('The model declined this request');
    }
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async function agentTurn(messages: ChatMessage[], tools: ToolDef[]): Promise<AgentTurnResult> {
    const { system, rest } = splitSystem(messages);
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      messages: rest.length > 0 ? rest : [{ role: 'user', content: '' }],
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ name: b.name, input: b.input }));

    return { text, toolCalls };
  }

  return { chat, agentTurn };
}
