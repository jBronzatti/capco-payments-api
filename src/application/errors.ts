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

interface CheckoutFailureDetails {
  /** The provider (or adapter) error behind this one; logged by type, code and stack only. */
  cause?: unknown;
  /** Whether FAIL was written; false when the payment had already left PENDING or the database kept failing. */
  stateRecorded: boolean;
}

/** The checkout could not be created; the payment is recorded as FAIL(CHECKOUT_FAILED) when the write succeeds. */
export class CardCheckoutFailedError extends Error {
  override readonly name = 'CardCheckoutFailedError';
  readonly stateRecorded: boolean;

  constructor(
    readonly paymentId: string,
    readonly code: 'PROVIDER_REJECTED' | 'COLLECTOR_MISMATCH',
    details: CheckoutFailureDetails,
  ) {
    super('The card checkout could not be created', { cause: details.cause });
    this.stateRecorded = details.stateRecorded;
  }
}

/** The provider's answer is unknown; recorded as FAIL(CHECKOUT_OUTCOME_UNKNOWN) when the write succeeds. */
export class CardCheckoutUncertainError extends Error {
  override readonly name = 'CardCheckoutUncertainError';
  readonly stateRecorded: boolean;

  constructor(
    readonly paymentId: string,
    readonly timedOut: boolean,
    details: CheckoutFailureDetails,
  ) {
    super('The outcome of the card checkout is unknown', { cause: details.cause });
    this.stateRecorded = details.stateRecorded;
  }
}

/** A checkout exists at the provider but could not be recorded; the payment stays PENDING without a URL. */
export class CardCheckoutNotPersistedError extends Error {
  override readonly name = 'CardCheckoutNotPersistedError';

  constructor(
    readonly paymentId: string,
    options: { cause?: unknown } = {},
  ) {
    super('The card checkout was created but could not be recorded', options);
  }
}

export class CardPaymentsUnavailableError extends Error {
  override readonly name = 'CardPaymentsUnavailableError';

  constructor() {
    super('Card payments are not configured on this deployment');
  }
}
