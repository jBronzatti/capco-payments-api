import { MercadoPagoError, MPConnectionError } from 'mercadopago';

// 4xx answers that do not prove the request was refused: 409 can be an idempotency conflict (the resource may
// exist), 423 and 424 are documented by the SDK as retryable, and 408/429 are timeouts and throttling.
const INCONCLUSIVE_4XX = new Set([408, 409, 423, 424, 429]);

/** Mercado Pago's definitive refusal; anything else leaves the outcome open. */
export function isDefinitiveRefusal(error: unknown): boolean {
  if (!(error instanceof MercadoPagoError) || error instanceof MPConnectionError) return false;
  return error.status >= 400 && error.status < 500 && !INCONCLUSIVE_4XX.has(error.status);
}

/**
 * The SDK wraps transport failures in MPConnectionError and keeps the original error in `__cause__`; its own
 * per-attempt timeout surfaces there as an AbortError (mercadopago 3.6.1, source-inspected).
 */
export function isTimeout(error: unknown): boolean {
  if (!(error instanceof MPConnectionError)) return false;
  const cause = (error as unknown as { __cause__?: { name?: unknown } }).__cause__;
  return cause?.name === 'AbortError';
}

/** Status code only: error bodies and SDK messages are never propagated. */
export function describe(error: unknown): string {
  return error instanceof MercadoPagoError
    ? `Mercado Pago responded with status ${error.status}`
    : 'Mercado Pago call failed';
}
