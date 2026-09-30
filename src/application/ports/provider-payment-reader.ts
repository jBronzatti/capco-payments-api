import { ProviderOutcome } from '../../domain/payment/payment-types';

/** The provider's authoritative view of one payment attempt; the webhook body is never trusted for any of it. */
export interface ProviderPayment {
  id: string;
  /** The provider's own status, kept verbatim as evidence. */
  status: string;
  outcome: ProviderOutcome;
  /** Our payment id, echoed back from the checkout; null when absent. */
  externalReference: string | null;
  /** Null when the provider amount is not an exact number of cents: never rounded into a match. */
  amountCents: number | null;
  currency: string | null;
  paymentType: string | null;
  collectorId: string | null;
}

export interface ProviderPaymentReader {
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
}

/** No trustworthy answer from the provider; the notification must be redelivered, not acknowledged. */
export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
}
