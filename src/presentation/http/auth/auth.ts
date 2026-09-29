import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ApiKeyAuthenticator, Principal } from './api-key-authenticator';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

const IS_PUBLIC = 'isPublic';

/** Marks routes that must not require an API key, such as health probes. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export class UnauthorizedError extends Error {
  override readonly name = 'UnauthorizedError';
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticator: ApiKeyAuthenticator,
    private readonly logger: PinoLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const principal = this.authenticator.authenticate(request.headers['x-api-key']);
    if (!principal) {
      this.logger.warn({ event: 'auth.failed' }, 'API key rejected');
      throw new UnauthorizedError('A valid API key is required');
    }
    request.principal = principal;
    return true;
  }
}
