import { Money } from '../../../src/domain/shared/money';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';

describe('Money', () => {
  it.each([
    [150.75, 15075],
    [19.99, 1999],
    [0.01, 1],
    [10, 1000],
    [10.5, 1050],
    [21474836.47, 2147483647],
  ])('converts %p to %p cents without floating-point drift', (amount, cents) => {
    expect(Money.fromDecimal(amount).cents).toBe(cents);
  });

  it.each([
    ['more than two decimals', 0.001],
    ['three decimals', 10.123],
    ['zero', 0],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['exponent-notation tiny value', 1e-7],
    ['above the integer column ceiling', 21474836.48],
    ['huge exponent value', 1e21],
    ['a value that only rounds to cents', 1.005],
    ['a floating-point sum that is not exactly two decimals', 0.1 + 0.2],
    ['negative zero', -0],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s', (_label, amount) => {
    expect(() => Money.fromDecimal(amount)).toThrow(DomainValidationError);
  });

  it('rejects non-integer or out-of-range cents', () => {
    expect(() => Money.fromCents(10.5)).toThrow(DomainValidationError);
    expect(() => Money.fromCents(0)).toThrow(DomainValidationError);
    expect(() => Money.fromCents(2147483648)).toThrow(DomainValidationError);
  });

  it('renders cents back as a decimal with at most two places', () => {
    expect(Money.fromCents(1999).toDecimal()).toBe(19.99);
    expect(Money.fromCents(1000).toDecimal()).toBe(10);
  });

  it('compares by value', () => {
    expect(Money.fromDecimal(19.99).equals(Money.fromCents(1999))).toBe(true);
    expect(Money.fromDecimal(19.99).equals(Money.fromCents(2000))).toBe(false);
  });
});
