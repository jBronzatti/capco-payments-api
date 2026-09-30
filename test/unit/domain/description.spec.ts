import { Description } from '../../../src/domain/shared/description';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';

describe('Description', () => {
  it('trims surrounding whitespace', () => {
    expect(Description.parse('  Pedido #123  ').value).toBe('Pedido #123');
  });

  it('accepts accented text up to 140 characters', () => {
    const text = 'ç'.repeat(140);
    expect(Description.parse(text).value).toBe(text);
  });

  it('counts characters, not UTF-16 code units, like the database column does', () => {
    expect(Description.parse('😀'.repeat(140)).value).toHaveLength(280);
    expect(() => Description.parse('😀'.repeat(141))).toThrow(DomainValidationError);
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '   '],
    ['longer than 140 characters', 'a'.repeat(141)],
    ['a line break', 'linha 1\nlinha 2'],
    ['a NUL character', 'abc\u0000def'],
    ['a DEL character', 'abc\u007fdef'],
    ['a C1 control character', 'abc\u0085def'],
    ['a lone surrogate', 'abc\ud800def'],
  ])('rejects %s', (_label, raw) => {
    expect(() => Description.parse(raw)).toThrow(DomainValidationError);
  });
});
