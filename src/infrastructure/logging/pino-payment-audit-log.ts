import { PinoLogger } from 'nestjs-pino';
import { PaymentAuditLog, StatusChangeRecord } from '../../application/ports/payment-audit-log';

/** Audit events go to the structured log stream; the record carries ids and states only, never CPF. */
export class PinoPaymentAuditLog implements PaymentAuditLog {
  constructor(private readonly logger: PinoLogger) {}

  statusChanged(record: StatusChangeRecord): void {
    this.logger.info({ event: 'payment.status_changed', ...record }, 'Payment status changed');
  }
}
