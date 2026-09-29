import { Controller, HttpCode, HttpException, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { CardPaymentsUnavailableError, ConcurrentUpdateError } from '../../../application/errors';
import { ProviderUnavailableError } from '../../../application/ports/provider-payment-reader';
import {
  SettleCardPaymentUseCase,
  SettlementReport,
} from '../../../application/use-cases/settle-card-payment.use-case';
import { DeadlineExceededError, withDeadline } from '../../../shared/deadline';
import { Public, UnauthorizedError } from '../auth/auth';
import { RequestValidationError } from '../validation';
import { ConcurrencyGate } from './concurrency-gate';
import { canonicalNotification, SignedNotification } from './mercado-pago-notification';
import { NotificationDeferredError } from './notification-deferred.error';
import { SourceFailureLimiter } from './source-failure-limiter';

export interface NotificationVerifier {
  verify(notification: SignedNotification): boolean;
}

/** Present only when card payments are configured. */
export interface MercadoPagoNotifications {
  verifier: NotificationVerifier;
  settlement: SettleCardPaymentUseCase;
}

/** Per instance: answer in time, bound the work in flight, turn away sources that keep sending bad requests. */
export interface WebhookProtection {
  /** The answer is due well before Mercado Pago's 22 s delivery timeout. */
  deadlineMs: number;
  gate: ConcurrencyGate;
  rejections: SourceFailureLimiter;
}

export const MERCADO_PAGO_NOTIFICATIONS = Symbol('MercadoPagoNotifications');
export const WEBHOOK_PROTECTION = Symbol('WebhookProtection');

const REPORT_EVENTS: Record<SettlementReport['kind'], { level: 'info' | 'warn' | 'error'; event: string }> = {
  APPLIED: { level: 'info', event: 'webhook.settled' },
  NO_OP: { level: 'info', event: 'webhook.no_op' },
  UNKNOWN_REFERENCE: { level: 'warn', event: 'webhook.unknown_reference' },
  REVERSAL: { level: 'warn', event: 'payment.provider_reversal' },
  MISMATCH: { level: 'error', event: 'payment.provider_mismatch' },
  DUPLICATE_APPROVAL: { level: 'error', event: 'payment.duplicate_approval' },
};

// Conditions that redelivery resolves on its own; any other cause is also a fault to investigate.
const EXPECTED_DEFERRALS = [ProviderUnavailableError, ConcurrentUpdateError, DeadlineExceededError];

/**
 * Mercado Pago's payment notifications. Authenticated by signature, not API key, and exempt from the per-IP
 * throttle (the provider may burst from shared addresses); only rejected requests count against a source.
 * The body is never trusted: a verified notification only names a payment, which is read back from Mercado
 * Pago. The answer is 200 once the outcome is committed or needs nothing, anything else asks for redelivery.
 */
@Public()
@SkipThrottle()
@Controller('api/webhooks')
export class MercadoPagoWebhookController {
  constructor(
    @Inject(MERCADO_PAGO_NOTIFICATIONS) private readonly notifications: MercadoPagoNotifications | null,
    @Inject(WEBHOOK_PROTECTION) private readonly protection: WebhookProtection,
    private readonly logger: PinoLogger,
  ) {}

  @Post('mercado-pago')
  @HttpCode(HttpStatus.OK)
  async receive(@Req() request: Request): Promise<void> {
    if (!this.notifications) throw new CardPaymentsUnavailableError();
    const notification = this.authenticate(request, this.notifications.verifier);
    if (notification.type !== 'payment') return;
    const report = await this.settle(notification.dataId, this.notifications.settlement);
    const { level, event } = REPORT_EVENTS[report.kind];
    this.logger[level](
      { event, paymentId: report.paymentId, providerPaymentId: notification.dataId },
      'Mercado Pago notification processed',
    );
  }

  /** Verification comes first, so a correctly signed notification is never refused because of its source. */
  private authenticate(request: Request, verifier: NotificationVerifier): SignedNotification {
    try {
      const notification = canonicalNotification(request);
      if (!verifier.verify(notification)) throw new UnauthorizedError('Invalid notification signature');
      return notification;
    } catch (error) {
      const event = rejectionEvent(error);
      if (event) this.countRejection(event, request.ip ?? 'unknown');
      throw error;
    }
  }

  /** A blocked source gets 429 without another log line, so repeating a bad request cannot flood the logs. */
  private countRejection(event: string, source: string): void {
    if (this.protection.rejections.isBlocked(source)) {
      throw new HttpException('Too many rejected notifications', HttpStatus.TOO_MANY_REQUESTS);
    }
    this.protection.rejections.recordFailure(source);
    this.logger.warn({ event }, 'Notification rejected');
  }

  private async settle(
    providerPaymentId: string,
    settlement: SettleCardPaymentUseCase,
  ): Promise<SettlementReport> {
    const work = this.protection.gate.run(() => settlement.execute({ providerPaymentId }));
    if (!work) {
      this.logger.warn(
        { event: 'webhook.deferred', providerPaymentId, reason: 'capacity' },
        'Notification deferred',
      );
      throw new NotificationDeferredError('Too many notifications in progress');
    }
    try {
      return await withDeadline(
        work,
        this.protection.deadlineMs,
        () => new DeadlineExceededError('Notification handling exceeded its deadline'),
      );
    } catch (error) {
      const level = EXPECTED_DEFERRALS.some((type) => error instanceof type) ? 'warn' : 'error';
      this.logger[level](
        { event: 'webhook.deferred', providerPaymentId, err: error },
        'Notification deferred',
      );
      throw new NotificationDeferredError('The notification could not be settled now', { cause: error });
    }
  }
}

function rejectionEvent(error: unknown): string | null {
  if (error instanceof RequestValidationError) return 'webhook.malformed';
  if (error instanceof UnauthorizedError) return 'webhook.signature_invalid';
  return null;
}
