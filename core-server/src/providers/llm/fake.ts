import type { AgentTurnResult, ChatMessage, LlmProvider, ToolDef } from '../types';

export interface FakeLlmOptions {
  /** Called with every messages array passed to chat()/agentTurn(), for assertions. */
  onCall?: (messages: ChatMessage[]) => void;
  /** Override the canned response. Defaults to echoing back an empty match list. */
  chatResponse?: (messages: ChatMessage[]) => string;
  /** If set, chat()/agentTurn() reject with this error instead of resolving. */
  failWith?: Error;
}

/**
 * Deterministic, network-free stand-in for LlmProvider used by every test
 * (LLM_PROVIDER=fake). Records every call so tests can assert on exactly
 * what payload reached "the LLM" — this is how NLM-04 verifies the
 * allow-listed shape without needing a real Anthropic call.
 */
export function createFakeLlmProvider(opts: FakeLlmOptions = {}): LlmProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];

  async function chat(messages: ChatMessage[]): Promise<string> {
    calls.push(messages);
    opts.onCall?.(messages);
    if (opts.failWith) throw opts.failWith;
    if (opts.chatResponse) return opts.chatResponse(messages);
    return '[]';
  }

  async function agentTurn(messages: ChatMessage[], _tools: ToolDef[]): Promise<AgentTurnResult> {
    const text = await chat(messages);
    return { text, toolCalls: [] };
  }

  return { chat, agentTurn, calls };
}
