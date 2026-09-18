// Provider adapter interfaces — crmex.md §6, verbatim shape.
// `agent/` and `api/` import only these interfaces; concrete vendors live
// one level down and are selected by src/providers/factory.ts.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AgentToolCall {
  name: string;
  input: unknown;
}

export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCall[];
}

export interface LlmProvider {
  chat(messages: ChatMessage[]): Promise<string>;
  agentTurn(messages: ChatMessage[], tools: ToolDef[]): Promise<AgentTurnResult>;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
}

export interface ImageGenProvider {
  generate(prompt: string, opts?: { width?: number; height?: number }): Promise<GeneratedImage>;
  /**
   * `history` is the session's prior prompts; providers that fall back to a
   * fresh generate() amend the prompt from it (crmex.md §6). Optional, so
   * a vendor with a true edit endpoint can ignore it.
   */
  edit(baseImage: Buffer, instruction: string, history?: Pick<PromptHistoryEntry, 'prompt'>[]): Promise<GeneratedImage>;
}

export interface ImageResult {
  id: string;
  thumbUrl: string;
  sourceUrl: string;
  source: string;
}

export interface ImageSearchProvider {
  search(query: string, limit?: number): Promise<ImageResult[]>;
}

/** Shared shape for one entry in an image_sessions.prompt_history array. */
export interface PromptHistoryEntry {
  role: 'user' | 'assistant';
  prompt: string;
  timestamp: string;
}
