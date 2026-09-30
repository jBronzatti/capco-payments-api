import { Payment, ProviderSettlement, SettlementResult } from '../../domain/payment/payment';
import { retryOnConflict } from '../optimistic-retry';
import { BindingField, ProviderAnomalyKind, ProviderAnomalyLog } from '../ports/provider-anomaly-log';
import { PaymentAuditLog } from '../ports/payment-audit-log';
import { PaymentRepository } from '../ports/payment-repository';
import { ProviderPayment, ProviderPaymentReader } from '../ports/provider-payment-reader';

export interface SettleCardPaymentCommand {
  /** Only an identifier: everything else is read back from the provider. */
  providerPaymentId: string;
}

export type SettlementReport =
  | { kind: 'APPLIED' | 'NO_OP' | Exclude<ProviderAnomalyKind, 'UNKNOWN_REFERENCE'>; paymentId: string }
  | { kind: 'UNKNOWN_REFERENCE'; paymentId: null };

const PROVIDER_ACTOR = 'system:mercado-pago';
const CURRENCY = 'BRL';
const CARD_PAYMENT_TYPE = 'credit_card';
// Checked before the lookup: PostgreSQL rejects a non-UUID id with an error, which would become a 503 and an
// endless redelivery instead of an unknown reference.
const PAYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies the provider's authoritative view of a card payment to ours. The provider payment must be bound to
 * the charge (our id as its reference, same amount in exact cents, BRL, a credit card, our account) before
 * its outcome counts; anything that does not bind, or that the domain will not apply on its own (a second
 * approval, a reversal), is kept as an anomaly for a person to resolve, with no automatic refund.
 */
export class SettleCardPaymentUseCase {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly provider: ProviderPaymentReader,
    private readonly anomalies: ProviderAnomalyLog,
    private readonly audit: PaymentAuditLog,
    private readonly collectorId: string,
  ) {}

  async execute(command: SettleCardPaymentCommand): Promise<SettlementReport> {
    const evidence = await this.provider.getPayment(command.providerPaymentId);
    return retryOnConflict(() => this.attempt(evidence));
  }

  /** The report, or null when another writer committed first and the payment must be read again. */
  private async attempt(evidence: ProviderPayment): Promise<SettlementReport | null> {
    const payment = await this.referencedPayment(evidence);
    if (!payment) return this.unknownReference(evidence);
    const mismatches = this.mismatchesBetween(payment, evidence);
    if (mismatches.length > 0) return this.flag(payment, evidence, 'MISMATCH', mismatches);
    const result = payment.applyProviderOutcome({
      providerPaymentId: evidence.id,
      outcome: evidence.outcome,
    });
    return this.resolve(payment, evidence, result);
  }

  private async referencedPayment(evidence: ProviderPayment): Promise<Payment | null> {
    const reference = evidence.externalReference;
    if (reference === null || !PAYMENT_ID.test(reference)) return null;
    return this.payments.findById(reference);
  }

  private mismatchesBetween(payment: Payment, evidence: ProviderPayment): BindingField[] {
    const facts: [BindingField, boolean][] = [
      ['paymentMethod', payment.paymentMethod === 'CREDIT_CARD'],
      ['amount', evidence.amountCents === payment.amount.cents],
      ['currency', evidence.currency === CURRENCY],
      ['paymentType', evidence.paymentType === CARD_PAYMENT_TYPE],
      ['collector', evidence.collectorId === this.collectorId],
    ];
    return facts.filter(([, holds]) => !holds).map(([field]) => field);
  }

  private async resolve(
    payment: Payment,
    evidence: ProviderPayment,
    result: SettlementResult,
  ): Promise<SettlementReport | null> {
    if (result.kind === 'APPLY') return this.write(payment, result.changes);
    if (result.kind === 'NO_OP') return { kind: 'NO_OP', paymentId: payment.id };
    return this.flag(payment, evidence, result.kind, []);
  }

  private async write(payment: Payment, changes: ProviderSettlement): Promise<SettlementReport | null> {
    const updated = await this.payments.update(payment.id, payment.version, changes);
    if (!updated) return null;
    this.audit.statusChanged({
      paymentId: payment.id,
      from: payment.status,
      to: changes.status,
      actor: PROVIDER_ACTOR,
    });
    return { kind: 'APPLIED', paymentId: payment.id };
  }

  private async flag(
    payment: Payment,
    evidence: ProviderPayment,
    kind: Exclude<ProviderAnomalyKind, 'UNKNOWN_REFERENCE'>,
    mismatches: BindingField[],
  ): Promise<SettlementReport> {
    await this.anomalies.record({
      kind,
      paymentId: payment.id,
      providerPaymentId: evidence.id,
      providerStatus: evidence.status,
      mismatches,
    });
    return { kind, paymentId: payment.id };
  }

  private async unknownReference(evidence: ProviderPayment): Promise<SettlementReport> {
    await this.anomalies.record({
      kind: 'UNKNOWN_REFERENCE',
      paymentId: null,
      providerPaymentId: evidence.id,
      providerStatus: evidence.status,
      mismatches: [],
    });
    return { kind: 'UNKNOWN_REFERENCE', paymentId: null };
  }
}
