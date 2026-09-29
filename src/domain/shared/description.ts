import { DomainValidationError } from './domain-validation.error';

const MAX_CHARACTERS = 140;
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

export class Description {
  private constructor(readonly value: string) {}

  static parse(raw: string): Description {
    const value = raw.trim();
    // Counted in code points, as PostgreSQL counts varchar(140); `.length` would count UTF-16 units.
    const characters = [...value].length;
    if (characters === 0 || characters > MAX_CHARACTERS || CONTROL_OR_LONE_SURROGATE.test(value)) {
      throw new DomainValidationError(
        'description',
        `description must have 1 to ${MAX_CHARACTERS} printable characters`,
      );
    }
    return new Description(value);
  }
}
