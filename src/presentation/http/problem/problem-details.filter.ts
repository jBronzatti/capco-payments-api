import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import {
  CardCheckoutFailedError,
  CardCheckoutNotPersistedError,
  CardCheckoutUncertainError,
  CardPaymentsUnavailableError,
  ConcurrentUpdateError,
  PaymentNotFoundError,
  PermissionDeniedError,
} from '../../../application/errors';
import { PaymentStateError, StatusManagedByProviderError } from '../../../domain/payment/errors';
import { DomainValidationError } from '../../../domain/shared/domain-validation.error';
import { UnauthorizedError } from '../auth/auth';
import { RequestValidationError } from '../validation';
import { Problem, problem, writeProblem } from './problem';

const HTTP_STATUS_PROBLEMS: Record<number, [slug: string, title: string]> = {
  400: ['validation-error', 'Invalid request'],
  404: ['not-found', 'Resource not found'],
  429: ['rate-limited', 'Too many requests'],
  503: ['service-unavailable', 'Service unavailable'],
};

/** Every error leaves as RFC 9457 problem+json; the request id identifies it, nothing from the request is echoed. */
@Catch()
@Injectable()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = toProblem(exception);
    // An unconfigured card integration is an expected, client-triggerable condition, not a server fault.
    if (body.status >= 500 && !(exception instanceof CardPaymentsUnavailableError)) {
      this.logger.error({ err: exception }, 'Request failed with a server error');
    }
    const request = host.switchToHttp().getRequest<Request>();
    writeProblem(host.switchToHttp().getResponse<Response>(), { ...body, requestId: String(request.id) });
  }
}

function toProblem(exception: unknown): Problem {
  if (exception instanceof RequestValidationError) return validationProblem(exception.errors);
  if (exception instanceof DomainValidationError) {
    return validationProblem([{ field: exception.field, message: exception.message }]);
  }
  if (exception instanceof UnauthorizedError) return problem(401, 'unauthorized', 'Authentication required');
  if (exception instanceof PermissionDeniedError) {
    return problem(403, 'forbidden', 'Permission denied', { detail: exception.message });
  }
  if (exception instanceof PaymentNotFoundError) return problem(404, 'not-found', 'Payment not found');
  if (exception instanceof StatusManagedByProviderError) {
    return problem(409, 'status-managed-by-provider', 'Operation not allowed', { detail: exception.message });
  }
  if (exception instanceof ConcurrentUpdateError) {
    return problem(409, 'version-conflict', 'Concurrent modification', { detail: exception.message });
  }
  if (exception instanceof PaymentStateError) {
    return problem(409, 'invalid-transition', 'Operation not allowed', { detail: exception.message });
  }
  if (exception instanceof CardPaymentsUnavailableError) {
    return problem(503, 'card-payments-unavailable', 'Card payments are not configured');
  }
  // Card checkout errors carry the payment id: the payment exists and the client can look it up.
  if (exception instanceof CardCheckoutFailedError) {
    return problem(502, 'checkout-failed', 'The card checkout could not be created', {
      paymentId: exception.paymentId,
    });
  }
  if (exception instanceof CardCheckoutUncertainError) {
    return problem(
      exception.timedOut ? 504 : 502,
      'checkout-outcome-unknown',
      'The card checkout outcome is unknown',
      {
        paymentId: exception.paymentId,
      },
    );
  }
  if (exception instanceof CardCheckoutNotPersistedError) {
    return problem(503, 'checkout-state-not-persisted', 'The card checkout could not be recorded', {
      paymentId: exception.paymentId,
    });
  }
  if (exception instanceof HttpException) return httpProblem(exception.getStatus());
  return problem(500, 'internal', 'Internal server error');
}

function httpProblem(status: number): Problem {
  const [slug, title] = HTTP_STATUS_PROBLEMS[status] ?? ['http-error', 'Request failed'];
  return problem(status, slug, title);
}

function validationProblem(errors: Problem['errors']): Problem {
  return problem(400, 'validation-error', 'Invalid request', { errors: errors ?? [] });
}
