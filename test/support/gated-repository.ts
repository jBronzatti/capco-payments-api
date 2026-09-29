import { PaymentPage, PaymentQuery, PaymentRepository } from '../../src/application/ports/payment-repository';
import { Payment, PaymentChanges } from '../../src/domain/payment/payment';

/**
 * Holds the first conditional write at a gate. `writeReached` resolves once the gated writer has read the
 * payment and is about to write, so the test can let another writer commit first — deterministically.
 */
export class GatedRepository implements PaymentRepository {
  reads = 0;
  readonly writeReached: Promise<void>;
  private signalWriteReached!: () => void;
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.open = resolve));
  private gated = true;

  constructor(private readonly inner: PaymentRepository) {
    this.writeReached = new Promise((resolve) => (this.signalWriteReached = resolve));
  }

  release(): void {
    this.open();
  }

  insert(payment: Payment): Promise<void> {
    return this.inner.insert(payment);
  }

  findById(id: string): Promise<Payment | null> {
    this.reads += 1;
    return this.inner.findById(id);
  }

  findMany(query: PaymentQuery): Promise<PaymentPage> {
    return this.inner.findMany(query);
  }

  async update(id: string, expectedVersion: number, changes: PaymentChanges): Promise<Payment | null> {
    if (this.gated) {
      this.gated = false;
      this.signalWriteReached();
      await this.gate;
    }
    return this.inner.update(id, expectedVersion, changes);
  }
}
