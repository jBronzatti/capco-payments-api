/** A request that is well-formed but not allowed in the payment's current state. */
export abstract class PaymentStateError extends Error {}

export class InvalidTransitionError extends PaymentStateError {
  override readonly name = 'InvalidTransitionError';
}

export class StatusManagedByProviderError extends PaymentStateError {
  override readonly name = 'StatusManagedByProviderError';

  constructor() {
    super('The status of a card payment is managed by the payment provider');
  }
}
