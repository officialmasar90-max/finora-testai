// ─── Finora AI Hub — Standard AI Types ─────────────────────────
//
// Provider-agnostic request/response contracts shared by the gateway and all
// provider adapters. No provider-specific concepts leak into these types.

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiChatRequest {
  /** Registered provider ID, e.g. "openai". Resolved by the provider registry. */
  providerId: string;
  /** Model ID as known by the provider, e.g. "gpt-4o-mini". */
  model: string;
  messages: AiMessage[];
  temperature?: number;
  /** Upper bound on generated (completion) tokens. */
  maxOutputTokens?: number;
  /** Abort the call if it exceeds this duration. Default set by adapter. */
  timeoutMs?: number;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AiChatResponse {
  text: string;
  usage?: AiUsage;
  providerId: string;
  model: string;
  /** Latency of the provider call in milliseconds. */
  latencyMs: number;
}
