import { DomainValidationError } from './domain-validation.error';

const MASKED_OR_PLAIN = /^(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})$/;
const REPEATED_DIGITS = /^(\d)\1{10}$/;

export class Cpf {
  private constructor(readonly value: string) {}

  static parse(raw: string): Cpf {
    if (!MASKED_OR_PLAIN.test(raw)) throw invalidCpf();
    const digits = raw.replace(/[.-]/g, '');
    if (REPEATED_DIGITS.test(digits) || !hasValidCheckDigits(digits)) throw invalidCpf();
    return new Cpf(digits);
  }
}

function hasValidCheckDigits(digits: string): boolean {
  const first = checkDigit(digits.slice(0, 9));
  const second = checkDigit(digits.slice(0, 10));
  return digits.endsWith(`${first}${second}`);
}

// Weights run from (length + 1) down to 2. (sum * 10) % 11 equals (11 - sum % 11) % 11, the usual rule,
// except that sum % 11 === 1 yields 10, which the rule maps to check digit 0.
function checkDigit(base: string): number {
  const sum = [...base].reduce((acc, digit, index) => acc + Number(digit) * (base.length + 1 - index), 0);
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

function invalidCpf(): DomainValidationError {
  return new DomainValidationError('cpf', 'CPF must have 11 digits with valid check digits');
}
