import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../http/auth/auth';

export interface ReadinessCheck {
  /** Resolves when the service can do useful work; rejects otherwise. */
  check(): Promise<void>;
}

export const READINESS_CHECK = Symbol('ReadinessCheck');

/** Liveness and readiness only; the bodies reveal no versions or internals. */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(READINESS_CHECK) private readonly readiness: ReadinessCheck) {}

  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: string }> {
    try {
      await this.readiness.check();
      return { status: 'ok' };
    } catch (error) {
      throw new ServiceUnavailableException(undefined, { cause: error });
    }
  }
}
