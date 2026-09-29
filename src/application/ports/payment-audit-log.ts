import { PaymentStatus } from '../../domain/payment/payment-types';

export interface StatusChangeRecord {
  paymentId: string;
  from: PaymentStatus;
  to: PaymentStatus;
  /**
   * The API key id of the caller, or a `system:` actor (e.g. `system:checkout`) for changes the service makes
   * itself; ':' cannot appear in a key id, so the two can never be confused.
   */
  actor: string;
}

/** Who changed which payment's status, and how, so a disputed change can be traced to an API key. */
export interface PaymentAuditLog {
  statusChanged(record: StatusChangeRecord): void;
}
