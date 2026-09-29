import { Payment, PaymentChanges } from '../../domain/payment/payment';
import { SettledStatus } from '../../domain/payment/payment-types';
import { Description } from '../../domain/shared/description';
import { DomainValidationError } from '../../domain/shared/domain-validation.error';
import { ConcurrentUpdateError, PaymentNotFoundError, PermissionDeniedError } from '../errors';
import { PaymentAuditLog } from '../ports/payment-audit-log';
import { PaymentRepository } from '../ports/payment-repository';

export interface UpdatePaymentCommand {
  id: string;
  description?: string;
  status?: SettledStatus;
  actor: { id: string; canSettle: boolean };
}

const MAX_ATTEMPTS = 2;

/**
 * Partial update under PUT (the spec's verb): description while PENDING, and manual PIX settlement for
 * callers with the settle permission. Each attempt re-reads the payment and re-applies the domain rules,
 * so a concurrent settlement can never be overwritten by a stale edit.
 */
export class UpdatePaymentUseCase {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly audit: PaymentAuditLog,
  ) {}

  async execute(command: UpdatePaymentCommand): Promise<Payment> {
    if (command.description === undefined && command.status === undefined) {
      throw new DomainValidationError('body', 'provide a description, a status, or both');
    }
    if (command.status !== undefined && !command.actor.canSettle) {
      throw new PermissionDeniedError('Changing the status requires the settle permission');
    }
    const description =
      command.description === undefined ? undefined : Description.parse(command.description);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(command, description);
      if (outcome) return outcome;
    }
    throw new ConcurrentUpdateError();
  }

  /** Returns the resulting payment, or null when another writer committed first. */
  private async attempt(
    command: UpdatePaymentCommand,
    description: Description | undefined,
  ): Promise<Payment | null> {
    const payment = await this.payments.findById(command.id);
    if (!payment) throw new PaymentNotFoundError(command.id);
    const changes = changesFor(payment, description, command.status);
    if (!changes) return payment;
    const updated = await this.payments.update(payment.id, payment.version, changes);
    if (updated && 'status' in changes) {
      this.audit.statusChanged({
        paymentId: payment.id,
        from: payment.status,
        to: changes.status,
        actor: command.actor.id,
      });
    }
    return updated;
  }
}

function changesFor(
  payment: Payment,
  description: Description | undefined,
  status: SettledStatus | undefined,
): PaymentChanges | null {
  const statusChange = status === undefined ? null : payment.settleManually(status);
  const descriptionChange = description === undefined ? null : payment.changeDescription(description);
  if (descriptionChange && statusChange) return { ...descriptionChange, ...statusChange };
  return descriptionChange ?? statusChange;
}
