import { DomainValidationError } from './domain-validation.error';

// Shortest decimal representation of a JS number, at most two decimal places, no sign, no exponent.
const DECIMAL_WITH_CENTS = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Positive amount in BRL cents. Bounded by the PostgreSQL `integer` column that stores it. */
export class Money {
  static readonly MAX_CENTS = 2_147_483_647;

  private constructor(readonly cents: number) {}

  static fromCents(cents: number): Money {
    if (!Number.isInteger(cents) || cents < 1 || cents > Money.MAX_CENTS) throw invalidAmount();
    return new Money(cents);
  }

  /** Never multiplies the float by 100 (19.99 * 100 = 1998.9999…); parses its decimal digits instead. */
  static fromDecimal(amount: number): Money {
    if (!Number.isFinite(amount)) throw invalidAmount();
    const match = DECIMAL_WITH_CENTS.exec(String(amount));
    if (!match) throw invalidAmount();
    const [, units = '', fraction = ''] = match;
    return Money.fromCents(Number(units) * 100 + Number(fraction.padEnd(2, '0')));
  }

  toDecimal(): number {
    return this.cents / 100;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents;
  }
}

function invalidAmount(): DomainValidationError {
  return new DomainValidationError(
    'amount',
    'amount must be a positive value with at most two decimal places',
  );
}
