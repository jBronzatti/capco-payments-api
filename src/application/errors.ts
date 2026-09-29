export class PaymentNotFoundError extends Error {
  override readonly name = 'PaymentNotFoundError';

  constructor(readonly paymentId: string) {
    super('Payment not found');
  }
}

export class CardPaymentsUnavailableError extends Error {
  override readonly name = 'CardPaymentsUnavailableError';

  constructor() {
    super('Card payments are not configured on this deployment');
  }
}
