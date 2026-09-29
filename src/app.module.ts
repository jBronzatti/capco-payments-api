import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { CheckoutGateway } from './application/ports/checkout-gateway';
import { PaymentAuditLog } from './application/ports/payment-audit-log';
import { PaymentRepository } from './application/ports/payment-repository';
import { CardCheckout, CreatePaymentUseCase } from './application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from './application/use-cases/get-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import { UpdatePaymentUseCase } from './application/use-cases/update-payment.use-case';
import { PrismaClient } from './generated/prisma/client';
import { AppConfig } from './infrastructure/config/app-config';
import { httpLoggerOptions } from './infrastructure/logging/http-logger.options';
import { PinoPaymentAuditLog } from './infrastructure/logging/pino-payment-audit-log';
import { MercadoPagoCheckoutGateway } from './infrastructure/mercado-pago/mercado-pago-checkout.gateway';
import { DatabaseReadiness } from './infrastructure/persistence/database-readiness';
import { createPrismaClient } from './infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from './infrastructure/persistence/prisma-payment.repository';
import { HealthController, READINESS_CHECK, ReadinessCheck } from './presentation/health/health.controller';
import { ApiKeyAuthenticator } from './presentation/http/auth/api-key-authenticator';
import { ApiKeyGuard } from './presentation/http/auth/auth';
import { PaymentController } from './presentation/http/payments/payment.controller';
import { ProblemDetailsFilter } from './presentation/http/problem/problem-details.filter';

const PAYMENT_REPOSITORY = Symbol('PaymentRepository');
const PAYMENT_AUDIT_LOG = Symbol('PaymentAuditLog');

export interface AppOverrides {
  logDestination?: DestinationStream;
  /** Tests replace the provider; card payments must still be enabled by configuration. */
  checkoutGateway?: CheckoutGateway;
}

function cardCheckout(config: AppConfig, overrides: AppOverrides): CardCheckout | null {
  if (!config.card) return null;
  const gateway =
    overrides.checkoutGateway ??
    new MercadoPagoCheckoutGateway({
      accessToken: config.card.accessToken,
      checkoutTtlMinutes: config.card.checkoutTtlMinutes,
      requestTimeoutMs: config.card.requestTimeoutMs,
    });
  return { gateway, collectorId: config.card.collectorId };
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
          useFactory: (payments: PaymentRepository, audit: PaymentAuditLog) =>
            new CreatePaymentUseCase(
              payments,
              { maxAmountCents: config.maxAmountCents },
              cardCheckout(config, overrides),
              audit,
            ),
          inject: [PAYMENT_REPOSITORY, PAYMENT_AUDIT_LOG],
        },
        {
          provide: GetPaymentUseCase,
          useFactory: (payments: PaymentRepository) => new GetPaymentUseCase(payments),
          inject: [PAYMENT_REPOSITORY],
        },
        {
          provide: ListPaymentsUseCase,
          useFactory: (payments: PaymentRepository) => new ListPaymentsUseCase(payments),
          inject: [PAYMENT_REPOSITORY],
        },
        {
          provide: PAYMENT_AUDIT_LOG,
          useFactory: (logger: PinoLogger): PaymentAuditLog => new PinoPaymentAuditLog(logger),
          inject: [PinoLogger],
        },
        {
          provide: UpdatePaymentUseCase,
          useFactory: (payments: PaymentRepository, audit: PaymentAuditLog) =>
            new UpdatePaymentUseCase(payments, audit),
          inject: [PAYMENT_REPOSITORY, PAYMENT_AUDIT_LOG],
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
