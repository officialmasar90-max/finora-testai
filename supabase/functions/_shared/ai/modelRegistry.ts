// ─── Finora AI Hub — Model Registry ────────────────────────────
//
// Central catalog of available models. Each task type lists ordered
// candidates from different providers; the router picks the best available
// one (secret configured + adapter registered + active). Adding a model
// means adding an entry here — no router or gateway changes.
//
// Capability tiers describe what a model is actually good at, so the router
// can match question complexity to model strength instead of assuming all
// models are equal.

export type AiTaskType =
  | "consultant-chat" // general financial questions — fast and efficient
  | "deep-analysis" // multi-part financial analysis, reasoning-heavy
  | "numeric-analysis"; // debt/budget comparisons, strict instruction following

export type CapabilityTier = "fast" | "balanced" | "advanced" | "reasoning";

export interface ModelEntry {
  providerId: string;
  /** Model ID exactly as the provider's API expects it. */
  modelId: string;
  displayName: string;
  /** Whether the router may route traffic to this model. */
  active: boolean;
  maxOutputTokens: number;
  supportsTemperature: boolean;
  /** Higher = tried first among same-tier candidates. */
  priority: number;
  capability: CapabilityTier;
}

export const MODEL_REGISTRY: Record<AiTaskType, ModelEntry[]> = {
  "consultant-chat": [
    {
      providerId: "openai",
      modelId: "gpt-4o-mini",
      displayName: "GPT-4o mini",
      active: true,
      maxOutputTokens: 800,
      supportsTemperature: true,
      priority: 90,
      capability: "fast",
    },
    {
      providerId: "gemini",
      modelId: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      active: true,
      maxOutputTokens: 800,
      supportsTemperature: true,
      priority: 80,
      capability: "fast",
    },
    {
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B (Groq)",
      active: true,
      maxOutputTokens: 800,
      supportsTemperature: true,
      priority: 70,
      capability: "fast",
    },
    {
      providerId: "mistral",
      modelId: "mistral-small-latest",
      displayName: "Mistral Small",
      active: true,
      maxOutputTokens: 800,
      supportsTemperature: true,
      priority: 60,
      capability: "fast",
    },
  ],
  "deep-analysis": [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 95,
      capability: "reasoning",
    },
    {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      displayName: "Claude Sonnet 4",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 90,
      capability: "reasoning",
    },
    {
      providerId: "deepseek",
      modelId: "deepseek-chat",
      displayName: "DeepSeek Chat",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 80,
      capability: "advanced",
    },
    {
      providerId: "openrouter",
      modelId: "openai/gpt-4o-mini",
      displayName: "GPT-4o mini (OpenRouter)",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 70,
      capability: "balanced",
    },
    {
      providerId: "gemini",
      modelId: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 60,
      capability: "fast",
    },
  ],
  "numeric-analysis": [
    {
      providerId: "openai",
      modelId: "gpt-4o",
      displayName: "GPT-4o",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 95,
      capability: "advanced",
    },
    {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      displayName: "Claude Sonnet 4",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 90,
      capability: "advanced",
    },
    {
      providerId: "deepseek",
      modelId: "deepseek-chat",
      displayName: "DeepSeek Chat",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 80,
      capability: "advanced",
    },
    {
      providerId: "gemini",
      modelId: "gemini-2.0-flash",
      displayName: "Gemini 2.0 Flash",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 70,
      capability: "fast",
    },
    {
      providerId: "groq",
      modelId: "llama-3.3-70b-versatile",
      displayName: "Llama 3.3 70B (Groq)",
      active: true,
      maxOutputTokens: 1200,
      supportsTemperature: true,
      priority: 60,
      capability: "fast",
    },
  ],
};

/** Default task when a request does not warrant special handling. */
export const DEFAULT_TASK: AiTaskType = "consultant-chat";
