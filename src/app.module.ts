import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { PaymentRepository } from './application/ports/payment-repository';
import { CreatePaymentUseCase } from './application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from './application/use-cases/get-payment.use-case';
import { PrismaClient } from './generated/prisma/client';
import { AppConfig } from './infrastructure/config/app-config';
import { httpLoggerOptions } from './infrastructure/logging/http-logger.options';
import { DatabaseReadiness } from './infrastructure/persistence/database-readiness';
import { createPrismaClient } from './infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from './infrastructure/persistence/prisma-payment.repository';
import { HealthController, READINESS_CHECK, ReadinessCheck } from './presentation/health/health.controller';
import { ApiKeyAuthenticator } from './presentation/http/auth/api-key-authenticator';
import { ApiKeyGuard } from './presentation/http/auth/auth';
import { PaymentController } from './presentation/http/payments/payment.controller';
import { ProblemDetailsFilter } from './presentation/http/problem/problem-details.filter';

const PAYMENT_REPOSITORY = Symbol('PaymentRepository');

export interface AppOverrides {
  logDestination?: DestinationStream;
}

@Injectable()
class PrismaShutdown implements OnApplicationShutdown {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/** Composition root: binds ports to adapters. Application code never sees Nest. */
@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    const loggerOptions = httpLoggerOptions(config.logLevel);
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: overrides.logDestination ? [loggerOptions, overrides.logDestination] : loggerOptions,
        }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
      ],
      controllers: [PaymentController, HealthController],
      providers: [
        { provide: PrismaClient, useFactory: () => createPrismaClient(config.databaseUrl) },
        PrismaShutdown,
        {
          provide: PAYMENT_REPOSITORY,
          useFactory: (prisma: PrismaClient) => new PrismaPaymentRepository(prisma),
          inject: [PrismaClient],
        },
        {
          provide: CreatePaymentUseCase,
          useFactory: (payments: PaymentRepository) =>
            new CreatePaymentUseCase(payments, { maxAmountCents: config.maxAmountCents }),
          inject: [PAYMENT_REPOSITORY],
        },
        {
          provide: GetPaymentUseCase,
          useFactory: (payments: PaymentRepository) => new GetPaymentUseCase(payments),
          inject: [PAYMENT_REPOSITORY],
        },
        {
          provide: READINESS_CHECK,
          useFactory: (prisma: PrismaClient): ReadinessCheck => new DatabaseReadiness(prisma),
          inject: [PrismaClient],
        },
        { provide: ApiKeyAuthenticator, useValue: new ApiKeyAuthenticator(config.apiKeys) },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
