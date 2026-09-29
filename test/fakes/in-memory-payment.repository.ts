import { PaymentPage, PaymentQuery, PaymentRepository } from '../../src/application/ports/payment-repository';
import { Payment, PaymentChanges, PaymentSnapshot } from '../../src/domain/payment/payment';

/** Mirrors the adapter contract: conditional, column-scoped updates guarded by version. */
export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly rows = new Map<string, PaymentSnapshot>();

  async insert(payment: Payment): Promise<void> {
    this.rows.set(payment.id, payment.toSnapshot());
  }

  async findById(id: string): Promise<Payment | null> {
    const row = this.rows.get(id);
    return row ? Payment.restore(row) : null;
  }

  async findMany(query: PaymentQuery): Promise<PaymentPage> {
    const matching = [...this.rows.values()]
      .filter((row) => !query.cpf || row.cpf === query.cpf)
      .filter((row) => !query.paymentMethod || row.paymentMethod === query.paymentMethod)
      .filter((row) => !query.status || row.status === query.status)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const start = (query.page - 1) * query.limit;
    return {
      items: matching.slice(start, start + query.limit).map((row) => Payment.restore(row)),
      total: matching.length,
    };
  }

  async update(id: string, expectedVersion: number, changes: PaymentChanges): Promise<Payment | null> {
    const row = this.rows.get(id);
    if (!row || row.version !== expectedVersion) return null;
    const updated = { ...row, ...changes, version: row.version + 1, updatedAt: new Date() };
    this.rows.set(id, updated);
    return Payment.restore(updated);
  }

  snapshot(id: string): PaymentSnapshot | undefined {
    return this.rows.get(id);
  }

  count(): number {
    return this.rows.size;
  }
}
