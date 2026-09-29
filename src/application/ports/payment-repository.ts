import { Payment, PaymentChanges } from '../../domain/payment/payment';
import { PaymentMethod, PaymentStatus } from '../../domain/payment/payment-types';

export interface PaymentQuery {
  cpf?: string;
  paymentMethod?: PaymentMethod;
  status?: PaymentStatus;
  page: number;
  limit: number;
}

export interface PaymentPage {
  items: Payment[];
  total: number;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
  findById(id: string): Promise<Payment | null>;
  /** Ordered by creation time, newest first, with id as the tie-breaker. */
  findMany(query: PaymentQuery): Promise<PaymentPage>;
  /**
   * Writes only the given columns and bumps the version, if and only if the stored version still equals
   * `expectedVersion`. Returns the updated payment, or null when another writer got there first.
   */
  update(id: string, expectedVersion: number, changes: PaymentChanges): Promise<Payment | null>;
}
