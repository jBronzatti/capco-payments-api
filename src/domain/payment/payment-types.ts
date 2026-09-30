export const PAYMENT_METHODS = ['PIX', 'CREDIT_CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAIL'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const SETTLED_STATUSES = ['PAID', 'FAIL'] as const;
export type SettledStatus = (typeof SETTLED_STATUSES)[number];

export const FAILURE_REASONS = [
  'CHECKOUT_FAILED',
  'CHECKOUT_OUTCOME_UNKNOWN',
  'PAYMENT_REJECTED',
  'MANUAL',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
export type CheckoutFailureReason = Extract<FailureReason, 'CHECKOUT_FAILED' | 'CHECKOUT_OUTCOME_UNKNOWN'>;

/** Provider-agnostic reading of a payment attempt reported by the card provider. */
export type ProviderOutcome = 'APPROVED' | 'REJECTED' | 'IN_PROGRESS' | 'REVERSED' | 'UNRECOGNIZED';

export interface ProviderPaymentReport {
  providerPaymentId: string;
  outcome: ProviderOutcome;
}
