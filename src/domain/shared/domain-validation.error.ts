/** Input that violates a domain invariant. `field` lets the HTTP layer report where, never the rejected value. */
export class DomainValidationError extends Error {
  override readonly name = 'DomainValidationError';

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}
