import { Cpf } from '../../../src/domain/shared/cpf';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';

describe('Cpf', () => {
  it('accepts a valid CPF without mask and keeps its 11 digits', () => {
    expect(Cpf.parse('12345678909').value).toBe('12345678909');
  });

  it('accepts a valid CPF with the usual mask and normalises it', () => {
    expect(Cpf.parse('123.456.789-09').value).toBe('12345678909');
  });

  it.each([
    ['wrong first check digit', '12345678919'],
    ['wrong second check digit', '12345678900'],
    ['repeated digits', '11111111111'],
    ['too short', '1234567890'],
    ['too long', '123456789091'],
    ['letters', '1234567890a'],
    ['unexpected separators', '123 456 789 09'],
    ['a partial mask', '123456.789-09'],
    ['another partial mask', '123.456789-09'],
    ['empty', ''],
  ])('rejects %s', (_label, raw) => {
    expect(() => Cpf.parse(raw)).toThrow(DomainValidationError);
  });
});
