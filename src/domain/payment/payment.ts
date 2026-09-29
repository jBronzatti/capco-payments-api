import { Cpf } from '../shared/cpf';
import { Description } from '../shared/description';
import { Money } from '../shared/money';
import { InvalidTransitionError, StatusManagedByProviderError } from './errors';
import {
  CheckoutFailureReason,
  FailureReason,
  PaymentMethod,
  PaymentStatus,
  ProviderOutcome,
  ProviderPaymentReport,
  SettledStatus,
} from './payment-types';

export interface PaymentSnapshot {
  id: string;
  cpf: string;
  description: string;
  amountCents: number;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  failureReason: FailureReason | null;
  providerPreferenceId: string | null;
  checkoutUrl: string | null;
  providerPaymentId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A status change always carries a consistent failure reason: absent for PAID, present for FAIL. */
export type StatusChange =
  { status: 'PAID'; failureReason: null } | { status: 'FAIL'; failureReason: FailureReason };

export interface CheckoutAttachment {
  providerPreferenceId: string;
  checkoutUrl: string;
}

/** The columns a state change touches. Persisted as a conditional, column-scoped update. */
export type PaymentChanges =
  | { description: string }
  | StatusChange
  | ({ description: string } & StatusChange)
  | ({ status: 'PAID'; failureReason: null } & { providerPaymentId: string })
  | CheckoutAttachment;

export interface NewPayment {
  id: string;
  cpf: Cpf;
  description: Description;
  amount: Money;
  paymentMethod: PaymentMethod;
}

export type SettlementResult =
  | { kind: 'APPLY'; changes: PaymentChanges }
  | { kind: 'NO_OP' }
  | { kind: 'DUPLICATE_APPROVAL' }
  | { kind: 'REVERSAL' };

type OutcomeRule = (state: PaymentSnapshot, report: ProviderPaymentReport) => SettlementResult;

const NO_OP: SettlementResult = Object.freeze({ kind: 'NO_OP' });

const OUTCOME_RULES: Record<ProviderOutcome, OutcomeRule> = {
  APPROVED: (state, { providerPaymentId }) => {
    if (state.status !== 'PAID') {
      return { kind: 'APPLY', changes: { status: 'PAID', failureReason: null, providerPaymentId } };
    }
    return state.providerPaymentId === providerPaymentId ? NO_OP : { kind: 'DUPLICATE_APPROVAL' };
  },
  REJECTED: (state) =>
    state.status === 'PENDING'
      ? { kind: 'APPLY', changes: { status: 'FAIL', failureReason: 'PAYMENT_REJECTED' } }
      : NO_OP,
  IN_PROGRESS: () => NO_OP,
  UNRECOGNIZED: () => NO_OP,
  // Only a reversal of the payment that settled this charge matters; refunding a losing duplicate does not.
  REVERSED: (state, { providerPaymentId }) =>
    state.status === 'PAID' && state.providerPaymentId === providerPaymentId ? { kind: 'REVERSAL' } : NO_OP,
};

export class Payment {
  private constructor(private readonly state: PaymentSnapshot) {}

  static create(input: NewPayment, now: Date): Payment {
    return new Payment({
      id: input.id,
      cpf: input.cpf.value,
      description: input.description.value,
      amountCents: input.amount.cents,
      paymentMethod: input.paymentMethod,
      status: 'PENDING',
      failureReason: null,
      providerPreferenceId: null,
      checkoutUrl: null,
      providerPaymentId: null,
      version: 0,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  }

  static restore(snapshot: PaymentSnapshot): Payment {
    return new Payment(copy(snapshot));
  }

  get id(): string {
    return this.state.id;
  }

  get version(): number {
    return this.state.version;
  }

  get paymentMethod(): PaymentMethod {
    return this.state.paymentMethod;
  }

  get status(): PaymentStatus {
    return this.state.status;
  }

  get amount(): Money {
    return Money.fromCents(this.state.amountCents);
  }

  hasCheckout(providerPreferenceId: string): boolean {
    return this.state.providerPreferenceId === providerPreferenceId;
  }

  failedWith(reason: FailureReason): boolean {
    return this.state.status === 'FAIL' && this.state.failureReason === reason;
  }

  toSnapshot(): PaymentSnapshot {
    return copy(this.state);
  }

  /** Returns null when the description is unchanged, so repeating a PUT stays idempotent. */
  changeDescription(description: Description): { description: string } | null {
    if (description.value === this.state.description) return null;
    if (this.state.status !== 'PENDING') {
      throw new InvalidTransitionError('The description can only change while the payment is PENDING');
    }
    return { description: description.value };
  }

  /** Manual settlement exists only because PIX has no provider integration yet. Returns null for a no-op. */
  settleManually(target: SettledStatus): StatusChange | null {
    if (this.state.paymentMethod === 'CREDIT_CARD') throw new StatusManagedByProviderError();
    if (this.state.status === target) return null;
    if (this.state.status !== 'PENDING') {
      throw new InvalidTransitionError(`A ${this.state.status} payment cannot change status`);
    }
    return target === 'FAIL'
      ? { status: 'FAIL', failureReason: 'MANUAL' }
      : { status: 'PAID', failureReason: null };
  }

  /** Returns null once the payment left PENDING: a checkout must never be attached over a settlement. */
  attachCheckout(providerPreferenceId: string, checkoutUrl: string): CheckoutAttachment | null {
    this.assertCard();
    if (this.state.providerPreferenceId !== null) {
      throw new InvalidTransitionError('A checkout can only be attached once');
    }
    if (this.state.status !== 'PENDING') return null;
    return { providerPreferenceId, checkoutUrl };
  }

  /** Returns null once the payment left PENDING: a creation error must never overwrite a settlement. */
  failCheckout(reason: CheckoutFailureReason): StatusChange | null {
    this.assertCard();
    if (this.state.status !== 'PENDING') return null;
    return { status: 'FAIL', failureReason: reason };
  }

  applyProviderOutcome(report: ProviderPaymentReport): SettlementResult {
    this.assertCard();
    return OUTCOME_RULES[report.outcome](this.state, report);
  }

  private assertCard(): void {
    if (this.state.paymentMethod !== 'CREDIT_CARD') {
      throw new InvalidTransitionError('This operation applies only to card payments');
    }
  }
}

function copy(snapshot: PaymentSnapshot): PaymentSnapshot {
  return { ...snapshot, createdAt: new Date(snapshot.createdAt), updatedAt: new Date(snapshot.updatedAt) };
}
