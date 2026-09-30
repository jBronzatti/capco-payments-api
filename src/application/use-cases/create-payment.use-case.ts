import { randomUUID } from 'node:crypto';
import { Payment } from '../../domain/payment/payment';
import { CheckoutFailureReason, PaymentMethod } from '../../domain/payment/payment-types';
import { Cpf } from '../../domain/shared/cpf';
import { Description } from '../../domain/shared/description';
import { DomainValidationError } from '../../domain/shared/domain-validation.error';
import { Money } from '../../domain/shared/money';
import {
  CardCheckoutFailedError,
  CardCheckoutNotPersistedError,
  CardCheckoutUncertainError,
  CardPaymentsUnavailableError,
} from '../errors';
import {
  CheckoutGateway,
  CheckoutOutcomeUnknownError,
  CheckoutRejectedError,
  CheckoutSession,
} from '../ports/checkout-gateway';
import { PaymentAuditLog } from '../ports/payment-audit-log';
import { PaymentRepository } from '../ports/payment-repository';

export interface CreatePaymentCommand {
  cpf: string;
  description: string;
  amount: number;
  paymentMethod: PaymentMethod;
}

export interface PaymentLimits {
  maxAmountCents: number;
}

export interface CardCheckout {
  gateway: CheckoutGateway;
  /** The provider account every checkout must belong to. */
  collectorId: string;
}

const WRITE_ATTEMPTS = 2;

type FailureWrite = 'WRITTEN' | 'NOTHING_TO_WRITE' | 'RETRY';
// Not a valid API key id (':' separates API_KEYS fields), so audit actors cannot be confused.
const CHECKOUT_ACTOR = 'system:checkout';

/**
 * PIX: persist PENDING. Card: commit PENDING first, make one provider call, then attach the checkout.
 * Every later write re-reads the payment and re-applies the domain rules, so a concurrent writer (a description
 * PUT today, the provider webhook later) is respected, a lost acknowledgement is recognised, and a payment that
 * already left PENDING is never overwritten. A timeout is an unknown outcome, never proof nothing was created.
 */
export class CreatePaymentUseCase {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly limits: PaymentLimits,
    private readonly card: CardCheckout | null,
    private readonly audit: PaymentAuditLog,
  ) {}

  async execute(command: CreatePaymentCommand): Promise<Payment> {
    const payment = Payment.create(
      {
        id: randomUUID(),
        cpf: Cpf.parse(command.cpf),
        description: Description.parse(command.description),
        amount: this.amountWithinLimit(command.amount),
        paymentMethod: command.paymentMethod,
      },
      new Date(),
    );
    const card = payment.paymentMethod === 'CREDIT_CARD' ? this.requireCard() : null;
    await this.payments.insert(payment);
    return card ? this.openCheckout(payment, card) : payment;
  }

  private requireCard(): CardCheckout {
    if (!this.card) throw new CardPaymentsUnavailableError();
    return this.card;
  }

  private async openCheckout(payment: Payment, card: CardCheckout): Promise<Payment> {
    const session = await this.requestCheckout(payment, card.gateway);
    if (session.collectorId !== card.collectorId) {
      const stateRecorded = await this.recordFailure(payment.id, 'CHECKOUT_FAILED');
      throw new CardCheckoutFailedError(payment.id, 'COLLECTOR_MISMATCH', { stateRecorded });
    }
    return this.attach(payment.id, session);
  }

  private async requestCheckout(payment: Payment, gateway: CheckoutGateway): Promise<CheckoutSession> {
    try {
      return await gateway.createCheckout(payment);
    } catch (error) {
      if (error instanceof CheckoutRejectedError) {
        const stateRecorded = await this.recordFailure(payment.id, 'CHECKOUT_FAILED');
        throw new CardCheckoutFailedError(payment.id, 'PROVIDER_REJECTED', { cause: error, stateRecorded });
      }
      // Anything else (timeout, 5xx, network, adapter bug) leaves the remote outcome unknown.
      const stateRecorded = await this.recordFailure(payment.id, 'CHECKOUT_OUTCOME_UNKNOWN');
      const timedOut = error instanceof CheckoutOutcomeUnknownError && error.timedOut;
      throw new CardCheckoutUncertainError(payment.id, timedOut, { cause: error, stateRecorded });
    }
  }

  /** Database-only retries: the provider is never called twice for the same payment. */
  private async attach(paymentId: string, session: CheckoutSession): Promise<Payment> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      try {
        const outcome = await this.tryAttach(paymentId, session);
        if (outcome) return outcome;
      } catch (error) {
        lastError = error;
      }
    }
    throw new CardCheckoutNotPersistedError(paymentId, { cause: lastError });
  }

  /** The payment to answer with, or null when another writer got in between and the write must be retried. */
  private async tryAttach(paymentId: string, session: CheckoutSession): Promise<Payment | null> {
    const current = await this.payments.findById(paymentId);
    if (!current) throw new Error('The payment disappeared before its checkout was recorded');
    if (current.hasCheckout(session.preferenceId)) return current;
    const changes = current.attachCheckout(session.preferenceId, session.checkoutUrl);
    if (!changes) return current;
    return this.payments.update(current.id, current.version, changes);
  }

  /** Whether FAIL was written; false when the payment already left PENDING or the database kept failing. */
  private async recordFailure(paymentId: string, reason: CheckoutFailureReason): Promise<boolean> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      const outcome = await this.tryRecordFailure(paymentId, reason).catch((): FailureWrite => 'RETRY');
      if (outcome !== 'RETRY') return outcome === 'WRITTEN';
    }
    return false;
  }

  private async tryRecordFailure(paymentId: string, reason: CheckoutFailureReason): Promise<FailureWrite> {
    const current = await this.payments.findById(paymentId);
    if (!current) return 'NOTHING_TO_WRITE';
    // An earlier attempt committed but its acknowledgement was lost: this flow is the only writer of
    // CHECKOUT_* reasons, so a matching FAIL is ours and still needs its audit record.
    if (current.failedWith(reason)) return this.audited(paymentId, 'WRITTEN');
    const changes = current.failCheckout(reason);
    if (!changes) return 'NOTHING_TO_WRITE';
    const failed = await this.payments.update(current.id, current.version, changes);
    return failed ? this.audited(paymentId, 'WRITTEN') : 'RETRY';
  }

  private audited(paymentId: string, outcome: FailureWrite): FailureWrite {
    this.audit.statusChanged({ paymentId, from: 'PENDING', to: 'FAIL', actor: CHECKOUT_ACTOR });
    return outcome;
  }

  private amountWithinLimit(amount: number): Money {
    const money = Money.fromDecimal(amount);
    if (money.cents > this.limits.maxAmountCents) {
      throw new DomainValidationError('amount', 'amount exceeds the maximum allowed per payment');
    }
    return money;
  }
}
