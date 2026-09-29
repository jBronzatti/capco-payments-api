import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule, PinoLogger } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { CheckoutGateway } from './application/ports/checkout-gateway';
import { PaymentAuditLog } from './application/ports/payment-audit-log';
import { PaymentRepository } from './application/ports/payment-repository';
import { ProviderAnomalyLog } from './application/ports/provider-anomaly-log';
import { ProviderPaymentReader } from './application/ports/provider-payment-reader';
import { CardCheckout, CreatePaymentUseCase } from './application/use-cases/create-payment.use-case';
import { GetPaymentUseCase } from './application/use-cases/get-payment.use-case';
import { ListPaymentsUseCase } from './application/use-cases/list-payments.use-case';
import { SettleCardPaymentUseCase } from './application/use-cases/settle-card-payment.use-case';
import { UpdatePaymentUseCase } from './application/use-cases/update-payment.use-case';
import { PrismaClient } from './generated/prisma/client';
import { AppConfig } from './infrastructure/config/app-config';
import { httpLoggerOptions } from './infrastructure/logging/http-logger.options';
import { PinoPaymentAuditLog } from './infrastructure/logging/pino-payment-audit-log';
import { MercadoPagoCheckoutGateway } from './infrastructure/mercado-pago/mercado-pago-checkout.gateway';
import { MercadoPagoNotificationVerifier } from './infrastructure/mercado-pago/mercado-pago-notification.verifier';
import { MercadoPagoPaymentReader } from './infrastructure/mercado-pago/mercado-pago-payment.reader';
import { DatabaseReadiness } from './infrastructure/persistence/database-readiness';
import { createPrismaClient } from './infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from './infrastructure/persistence/prisma-payment.repository';
import { PrismaProviderAnomalyLog } from './infrastructure/persistence/prisma-provider-anomaly-log';
import { HealthController, READINESS_CHECK, ReadinessCheck } from './presentation/health/health.controller';
import { ApiKeyAuthenticator } from './presentation/http/auth/api-key-authenticator';
import { ApiKeyGuard } from './presentation/http/auth/auth';
import { PaymentController } from './presentation/http/payments/payment.controller';
import { ProblemDetailsFilter } from './presentation/http/problem/problem-details.filter';
import { ConcurrencyGate } from './presentation/http/webhooks/concurrency-gate';
import {
  MERCADO_PAGO_NOTIFICATIONS,
  MercadoPagoNotifications,
  MercadoPagoWebhookController,
  WEBHOOK_PROTECTION,
  WebhookProtection,
} from './presentation/http/webhooks/mercado-pago-webhook.controller';
import { SourceFailureLimiter } from './presentation/http/webhooks/source-failure-limiter';

const PAYMENT_REPOSITORY = Symbol('PaymentRepository');
const PAYMENT_AUDIT_LOG = Symbol('PaymentAuditLog');
const PROVIDER_ANOMALY_LOG = Symbol('ProviderAnomalyLog');

export interface WebhookLimits {
  deadlineMs: number;
  maxConcurrentSettlements: number;
  /** Malformed or unauthenticated requests tolerated per source address per minute. */
  failuresPerMinute: number;
}

// A notification is answered within 10 s (Mercado Pago waits 22 s); the payment read gets 4 s of that.
const WEBHOOK_LIMITS_DEFAULTS: WebhookLimits = {
  deadlineMs: 10_000,
  maxConcurrentSettlements: 8,
  failuresPerMinute: 20,
};
const PAYMENT_READ_TIMEOUT_MS = 4_000;
const MAX_TRACKED_SOURCES = 10_000;

export interface AppOverrides {
  logDestination?: DestinationStream;
  /** Tests replace the provider; card payments must still be enabled by configuration. */
  checkoutGateway?: CheckoutGateway;
  paymentReader?: ProviderPaymentReader;
  webhookLimits?: Partial<WebhookLimits>;
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

function mercadoPagoNotifications(
  config: AppConfig,
  overrides: AppOverrides,
  ports: { payments: PaymentRepository; anomalies: ProviderAnomalyLog; audit: PaymentAuditLog },
): MercadoPagoNotifications | null {
  if (!config.card) return null;
  const reader =
    overrides.paymentReader ??
    new MercadoPagoPaymentReader({
      accessToken: config.card.accessToken,
      requestTimeoutMs: PAYMENT_READ_TIMEOUT_MS,
    });
  return {
    verifier: new MercadoPagoNotificationVerifier(config.card.webhookSecret),
    settlement: new SettleCardPaymentUseCase(
      ports.payments,
      reader,
      ports.anomalies,
      ports.audit,
      config.card.collectorId,
    ),
  };
}

function webhookProtection(limits: WebhookLimits): WebhookProtection {
  return {
    deadlineMs: limits.deadlineMs,
    gate: new ConcurrencyGate(limits.maxConcurrentSettlements),
    rejections: new SourceFailureLimiter({
      limit: limits.failuresPerMinute,
      windowMs: 60_000,
      maxSources: MAX_TRACKED_SOURCES,
    }),
  };
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
      controllers: [PaymentController, MercadoPagoWebhookController, HealthController],
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
          provide: PROVIDER_ANOMALY_LOG,
          useFactory: (prisma: PrismaClient): ProviderAnomalyLog => new PrismaProviderAnomalyLog(prisma),
          inject: [PrismaClient],
        },
        {
          provide: MERCADO_PAGO_NOTIFICATIONS,
          useFactory: (payments: PaymentRepository, anomalies: ProviderAnomalyLog, audit: PaymentAuditLog) =>
            mercadoPagoNotifications(config, overrides, { payments, anomalies, audit }),
          inject: [PAYMENT_REPOSITORY, PROVIDER_ANOMALY_LOG, PAYMENT_AUDIT_LOG],
        },
        {
          provide: WEBHOOK_PROTECTION,
          useFactory: () => webhookProtection({ ...WEBHOOK_LIMITS_DEFAULTS, ...overrides.webhookLimits }),
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
