import { ProviderPayment, ProviderPaymentReader } from '../../src/application/ports/provider-payment-reader';

type Answer = () => Promise<ProviderPayment>;

/** Scripted provider answers keyed by provider payment id; an id without a script is a test error. */
export class FakeProviderPaymentReader implements ProviderPaymentReader {
  private readonly answers = new Map<string, Answer>();
  readonly requested: string[] = [];

  willReturn(payment: ProviderPayment): void {
    this.answers.set(payment.id, async () => payment);
  }

  willFail(providerPaymentId: string, error: Error): void {
    this.answers.set(providerPaymentId, async () => {
      throw error;
    });
  }

  /** Never answers, like a provider that accepted the connection and went silent. */
  willHang(providerPaymentId: string): void {
    this.answers.set(providerPaymentId, () => new Promise<never>(() => undefined));
  }

  reset(): void {
    this.answers.clear();
    this.requested.length = 0;
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    this.requested.push(providerPaymentId);
    const answer = this.answers.get(providerPaymentId);
    if (!answer) throw new Error(`no scripted answer for ${providerPaymentId}`);
    return answer();
  }
}
