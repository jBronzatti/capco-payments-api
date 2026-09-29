import { PaymentStatus } from '../../domain/payment/payment-types';

export interface StatusChangeRecord {
  paymentId: string;
  from: PaymentStatus;
  to: PaymentStatus;
  /** The API key id of the caller, or the provider for provider-driven changes. */
  actor: string;
}

/** Who changed which payment's status, and how, so a disputed change can be traced to an API key. */
export interface PaymentAuditLog {
  statusChanged(record: StatusChangeRecord): void;
}
