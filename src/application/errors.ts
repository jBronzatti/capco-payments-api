export class PaymentNotFoundError extends Error {
  override readonly name = 'PaymentNotFoundError';

  constructor(readonly paymentId: string) {
    super('Payment not found');
  }
}

export class PermissionDeniedError extends Error {
  override readonly name = 'PermissionDeniedError';
}

/** Another writer kept changing the payment between our read and our conditional write. */
export class ConcurrentUpdateError extends Error {
  override readonly name = 'ConcurrentUpdateError';

  constructor() {
    super('The payment was modified concurrently; retry with its current state');
  }
}

export class CardPaymentsUnavailableError extends Error {
  override readonly name = 'CardPaymentsUnavailableError';

  constructor() {
    super('Card payments are not configured on this deployment');
  }
}
