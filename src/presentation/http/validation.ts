import { ParseUUIDPipe, ValidationError, ValidationPipe } from '@nestjs/common';
import { FieldProblem } from './problem/problem';

export class RequestValidationError extends Error {
  override readonly name = 'RequestValidationError';

  constructor(readonly errors: FieldProblem[]) {
    super('Request validation failed');
  }
}

/** Unknown fields are rejected (not stripped silently); no implicit type coercion of request bodies. */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    exceptionFactory: (errors) => new RequestValidationError(errors.map(toFieldProblem)),
  });
}

/** Path ids are UUIDs; anything else is rejected before any lookup, in the same shape as body errors. */
export function uuidParam(field: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new RequestValidationError([{ field, message: `${field} must be a UUID` }]),
  });
}

// An unknown field's name comes from the client, so it is echoed only when it looks like a field name.
const ECHOABLE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function toFieldProblem(error: ValidationError): FieldProblem {
  if (error.constraints?.whitelistValidation !== undefined) {
    const field = ECHOABLE_FIELD.test(error.property) ? error.property : '(unrecognized field)';
    return { field, message: 'is not an accepted field' };
  }
  const messages = Object.values(error.constraints ?? {});
  return { field: error.property, message: messages.length > 0 ? messages.join('; ') : 'is invalid' };
}
