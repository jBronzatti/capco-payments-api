import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  CardPaymentsUnavailableError,
  ConcurrentUpdateError,
  PaymentNotFoundError,
  PermissionDeniedError,
} from '../../../src/application/errors';
import { InvalidTransitionError, StatusManagedByProviderError } from '../../../src/domain/payment/errors';
import { DomainValidationError } from '../../../src/domain/shared/domain-validation.error';
import { UnauthorizedError } from '../../../src/presentation/http/auth/auth';
import { ProblemDetailsFilter } from '../../../src/presentation/http/problem/problem-details.filter';
import { RequestValidationError } from '../../../src/presentation/http/validation';

function respond(exception: unknown): { status: number; body: Record<string, unknown> } {
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    type() {
      return this;
    },
    send(payload: string) {
      captured.body = JSON.parse(payload) as Record<string, unknown>;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => ({ id: 'req-1' }), getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const logger = { error: jest.fn() } as unknown as PinoLogger;
  new ProblemDetailsFilter(logger).catch(exception, host);
  return captured;
}

describe('ProblemDetailsFilter', () => {
  it.each([
    [new RequestValidationError([{ field: 'cpf', message: 'x' }]), 400, 'validation-error'],
    [new DomainValidationError('amount', 'x'), 400, 'validation-error'],
    [new UnauthorizedError('x'), 401, 'unauthorized'],
    [new PermissionDeniedError('x'), 403, 'forbidden'],
    [new PaymentNotFoundError('id'), 404, 'not-found'],
    [new NotFoundException(), 404, 'not-found'],
    [new StatusManagedByProviderError(), 409, 'status-managed-by-provider'],
    [new ConcurrentUpdateError(), 409, 'version-conflict'],
    [new InvalidTransitionError('x'), 409, 'invalid-transition'],
    [new CardPaymentsUnavailableError(), 503, 'card-payments-unavailable'],
    [new Error('boom with internals'), 500, 'internal'],
  ])('maps %p to %p %p', (exception, status, slug) => {
    const { status: sent, body } = respond(exception);

    expect(sent).toBe(status);
    expect(body).toMatchObject({ type: `/problems/${slug}`, status, requestId: 'req-1' });
  });

  it('never exposes an unexpected error message', () => {
    expect(JSON.stringify(respond(new Error('secret internals')).body)).not.toContain('secret internals');
  });
});
