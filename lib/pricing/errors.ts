export type PricingErrorCode =
  | "INVALID_INSTANT"
  | "NEGATIVE_INTERVAL"
  | "INVALID_SETTINGS"
  | "INVALID_RATE_CARD"
  | "NO_RATE_CARD";

export class PricingError extends Error {
  readonly code: PricingErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: PricingErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PricingError";
    this.code = code;
    this.detail = detail;
  }
}

export function isPricingError(e: unknown): e is PricingError {
  return e instanceof PricingError;
}
