// ─── Finora AI Hub — Standard Error Handling ───────────────────
//
// Every provider adapter maps its provider's raw failures into this single
// error shape, so the gateway can make decisions (retry, fallback, inform
// user) without knowing provider specifics.

export type AiErrorCode =
  | "authentication" // API key invalid or revoked — retrying will not help
  | "quota" // billing / credits exhausted — retrying will not help
  | "rate_limit" // transient throttling — retry may succeed
  | "timeout" // call exceeded the time budget — retry may succeed
  | "invalid_response" // provider answered but the body is unusable
  | "server" // provider-side 5xx — retry may succeed
  | "unknown";

export class AiProviderError extends Error {
  readonly code: AiErrorCode;
  readonly providerId: string;
  readonly /** HTTP status returned by the provider, if any. */
  readonly status?: number;
  readonly /** Whether a retry of the same provider is worth attempting. */
  readonly retryable: boolean;

  constructor(args: {
    code: AiErrorCode;
    providerId: string;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "AiProviderError";
    this.code = args.code;
    this.providerId = args.providerId;
    this.status = args.status;
    this.retryable = args.retryable ?? false;
  }
}

/** Map a provider HTTP status to a standard error code. */
export function codeFromStatus(providerId: string, status: number): AiProviderError {
  if (status === 401 || status === 403) {
    return new AiProviderError({
      code: "authentication",
      providerId,
      message: `Provider ${providerId} rejected the API key (HTTP ${status}).`,
      status,
    });
  }
  if (status === 429) {
    return new AiProviderError({
      code: "rate_limit",
      providerId,
      message: `Provider ${providerId} is throttling requests (HTTP 429).`,
      status,
      retryable: true,
    });
  }
  if (status >= 500) {
    return new AiProviderError({
      code: "server",
      providerId,
      message: `Provider ${providerId} returned a server error (HTTP ${status}).`,
      status,
      retryable: true,
    });
  }
  return new AiProviderError({
    code: "unknown",
    providerId,
    message: `Provider ${providerId} returned an unexpected status (HTTP ${status}).`,
    status,
  });
}
