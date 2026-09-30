import { Payment } from '../../domain/payment/payment';

export interface CheckoutSession {
  preferenceId: string;
  checkoutUrl: string;
  /** The provider account that owns the checkout; must match the configured one. */
  collectorId: string;
}

/** Hosted checkout at the card provider (Mercado Pago Checkout Pro preferences). */
export interface CheckoutGateway {
  createCheckout(payment: Payment): Promise<CheckoutSession>;
}

/** The provider answered and refused: no usable checkout exists. */
export class CheckoutRejectedError extends Error {
  override readonly name = 'CheckoutRejectedError';
}

/** No trustworthy answer (timeout, connection loss, 5xx, 429): a checkout may or may not exist remotely. */
export class CheckoutOutcomeUnknownError extends Error {
  override readonly name = 'CheckoutOutcomeUnknownError';

  constructor(
    message: string,
    readonly timedOut: boolean,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
  }
}
