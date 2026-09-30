import { CheckoutGateway, CheckoutSession } from '../../src/application/ports/checkout-gateway';
import { Payment } from '../../src/domain/payment/payment';

/** The Mercado Pago account the fake answers for; tests configure the same id. */
export const TEST_COLLECTOR_ID = '111222333';

type Behaviour = (payment: Payment) => Promise<CheckoutSession>;

const succeed: Behaviour = async (payment) => ({
  preferenceId: `pref-${payment.id}`,
  checkoutUrl: `https://checkout.example/${payment.id}`,
  collectorId: TEST_COLLECTOR_ID,
});

/** Scripted provider: records every call and answers with whatever the test configures. */
export class FakeCheckoutGateway implements CheckoutGateway {
  readonly calls: Payment[] = [];
  private behaviour: Behaviour = succeed;

  willAnswer(behaviour: Behaviour): void {
    this.behaviour = behaviour;
  }

  reset(): void {
    this.behaviour = succeed;
    this.calls.length = 0;
  }

  async createCheckout(payment: Payment): Promise<CheckoutSession> {
    this.calls.push(payment);
    return this.behaviour(payment);
  }
}
