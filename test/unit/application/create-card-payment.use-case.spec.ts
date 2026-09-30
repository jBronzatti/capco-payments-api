import {
  CardCheckoutNotPersistedError,
  CardCheckoutUncertainError,
  CardPaymentsUnavailableError,
} from '../../../src/application/errors';
import {
  CheckoutOutcomeUnknownError,
  CheckoutRejectedError,
} from '../../../src/application/ports/checkout-gateway';
import { CreatePaymentUseCase } from '../../../src/application/use-cases/create-payment.use-case';
import { PaymentChanges, PaymentSnapshot } from '../../../src/domain/payment/payment';
import { FakeCheckoutGateway, TEST_COLLECTOR_ID } from '../../fakes/fake-checkout-gateway';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';
import { RecordingAuditLog } from '../../fakes/recording-audit-log';

const CARD = {
  cpf: '12345678909',
  description: 'Pedido cartão',
  amount: 150.75,
  paymentMethod: 'CREDIT_CARD' as const,
};
const ACTOR = 'system:checkout';

/** Simulates database trouble on the next conditional writes. */
class FlakyRepository extends InMemoryPaymentRepository {
  private failures = 0;
  private lostAcknowledgements = 0;

  /** The write never happens. */
  failNextUpdates(count: number): void {
    this.failures = count;
  }

  /** The write commits, but the reply is lost (the caller sees an error). */
  loseNextAcknowledgement(): void {
    this.lostAcknowledgements = 1;
  }

  override async update(id: string, expectedVersion: number, changes: PaymentChanges) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('database unavailable');
    }
    const result = await super.update(id, expectedVersion, changes);
    if (this.lostAcknowledgements > 0) {
      this.lostAcknowledgements -= 1;
      throw new Error('connection reset after commit');
    }
    return result;
  }

  only(): PaymentSnapshot | undefined {
    return this.all()[0];
  }

  /** Another writer (a description PUT, or a webhook) commits while the provider call is in flight. */
  async concurrentWrite(id: string, changes: PaymentChanges): Promise<void> {
    const current = this.snapshot(id);
    if (current) await super.update(id, current.version, changes);
  }
}

describe('CreatePaymentUseCase — card checkout', () => {
  let repository: FlakyRepository;
  let gateway: FakeCheckoutGateway;
  let audit: RecordingAuditLog;
  let useCase: CreatePaymentUseCase;

  beforeEach(() => {
    repository = new FlakyRepository();
    gateway = new FakeCheckoutGateway();
    audit = new RecordingAuditLog();
    useCase = new CreatePaymentUseCase(
      repository,
      { maxAmountCents: 100_000_000 },
      { gateway, collectorId: TEST_COLLECTOR_ID },
      audit,
    );
  });

  const rejectWith = (error: Error) =>
    gateway.willAnswer(async () => {
      throw error;
    });

  it('commits the PENDING payment before calling the provider', async () => {
    let seenByProvider: PaymentSnapshot | undefined;
    gateway.willAnswer(async (payment) => {
      seenByProvider = repository.snapshot(payment.id);
      return {
        preferenceId: 'pref-1',
        checkoutUrl: 'https://checkout.example/1',
        collectorId: TEST_COLLECTOR_ID,
      };
    });

    await useCase.execute(CARD);

    expect(seenByProvider).toMatchObject({ status: 'PENDING', version: 0 });
    expect(gateway.calls).toHaveLength(1);
  });

  it('attaches the checkout and returns a payment the buyer can pay', async () => {
    const payment = await useCase.execute(CARD);

    expect(payment.toSnapshot()).toMatchObject({
      status: 'PENDING',
      providerPreferenceId: `pref-${payment.id}`,
      checkoutUrl: `https://checkout.example/${payment.id}`,
      version: 1,
    });
    expect(repository.snapshot(payment.id)?.checkoutUrl).toBe(`https://checkout.example/${payment.id}`);
  });

  it('refuses card payments before writing anything when they are not configured', async () => {
    const unconfigured = new CreatePaymentUseCase(repository, { maxAmountCents: 100_000_000 }, null, audit);

    await expect(unconfigured.execute(CARD)).rejects.toThrow(CardPaymentsUnavailableError);
    expect(repository.count()).toBe(0);
  });

  it('records FAIL(CHECKOUT_FAILED) on a definitive rejection, keeping the provider error as cause', async () => {
    const rejection = new CheckoutRejectedError('Mercado Pago responded with status 400');
    rejectWith(rejection);

    const attempt = useCase.execute(CARD);

    await expect(attempt).rejects.toMatchObject({ name: 'CardCheckoutFailedError', cause: rejection });
    const stored = repository.only();
    expect(stored).toMatchObject({ status: 'FAIL', failureReason: 'CHECKOUT_FAILED' });
    expect(audit.records).toEqual([{ paymentId: stored?.id, from: 'PENDING', to: 'FAIL', actor: ACTOR }]);
  });

  it.each([
    ['a timeout', new CheckoutOutcomeUnknownError('timed out', true), true],
    ['a provider 5xx', new CheckoutOutcomeUnknownError('bad gateway', false), false],
    ['an unexpected adapter error', new TypeError('cannot read properties of undefined'), false],
  ])(
    'treats %s as an unknown outcome, never as proof nothing was created',
    async (_label, error, timedOut) => {
      rejectWith(error);

      const attempt = useCase.execute(CARD);

      await expect(attempt).rejects.toThrow(CardCheckoutUncertainError);
      await expect(attempt).rejects.toMatchObject({
        timedOut,
        cause: error,
        paymentId: repository.only()?.id,
      });
      expect(repository.only()).toMatchObject({ status: 'FAIL', failureReason: 'CHECKOUT_OUTCOME_UNKNOWN' });
    },
  );

  it('refuses a checkout created on another Mercado Pago account than the configured one', async () => {
    gateway.willAnswer(async () => ({
      preferenceId: 'pref-x',
      checkoutUrl: 'https://checkout.example/x',
      collectorId: '999',
    }));

    await expect(useCase.execute(CARD)).rejects.toMatchObject({
      name: 'CardCheckoutFailedError',
      code: 'COLLECTOR_MISMATCH',
    });
    const stored = repository.only();
    expect(stored).toMatchObject({ status: 'FAIL', failureReason: 'CHECKOUT_FAILED', checkoutUrl: null });
    expect(audit.records).toEqual([{ paymentId: stored?.id, from: 'PENDING', to: 'FAIL', actor: ACTOR }]);
  });

  describe('when the database misbehaves after the provider answered', () => {
    it('retries a failed attach once against the database, never calling the provider again', async () => {
      repository.failNextUpdates(1);

      const payment = await useCase.execute(CARD);

      expect(gateway.calls).toHaveLength(1);
      expect(payment.toSnapshot().checkoutUrl).toBe(`https://checkout.example/${payment.id}`);
    });

    it('recognises an attach that committed although its acknowledgement was lost', async () => {
      repository.loseNextAcknowledgement();

      const payment = await useCase.execute(CARD);

      expect(gateway.calls).toHaveLength(1);
      expect(payment.toSnapshot()).toMatchObject({
        checkoutUrl: `https://checkout.example/${payment.id}`,
        version: 1,
      });
    });

    it('reports a checkout it could not record, leaving the payment PENDING without a URL', async () => {
      repository.failNextUpdates(2);

      await expect(useCase.execute(CARD)).rejects.toThrow(CardCheckoutNotPersistedError);
      expect(gateway.calls).toHaveLength(1);
      expect(repository.only()).toMatchObject({ status: 'PENDING', checkoutUrl: null });
    });

    it('recognises a FAIL write that committed although its acknowledgement was lost, and audits it once', async () => {
      gateway.willAnswer(async () => {
        repository.loseNextAcknowledgement();
        throw new CheckoutRejectedError('Mercado Pago responded with status 400');
      });

      await expect(useCase.execute(CARD)).rejects.toMatchObject({ stateRecorded: true });
      const stored = repository.only();
      expect(stored).toMatchObject({ status: 'FAIL', failureReason: 'CHECKOUT_FAILED' });
      expect(audit.records).toEqual([{ paymentId: stored?.id, from: 'PENDING', to: 'FAIL', actor: ACTOR }]);
    });

    it('recovers from one database failure while recording the checkout failure', async () => {
      gateway.willAnswer(async () => {
        repository.failNextUpdates(1);
        throw new CheckoutRejectedError('Mercado Pago responded with status 400');
      });

      await expect(useCase.execute(CARD)).rejects.toMatchObject({ stateRecorded: true });
      expect(repository.only()).toMatchObject({ status: 'FAIL', failureReason: 'CHECKOUT_FAILED' });
    });

    it('still reports the checkout failure when recording it keeps failing, and says it was not recorded', async () => {
      gateway.willAnswer(async () => {
        repository.failNextUpdates(2);
        throw new CheckoutRejectedError('Mercado Pago responded with status 400');
      });

      await expect(useCase.execute(CARD)).rejects.toMatchObject({
        name: 'CardCheckoutFailedError',
        stateRecorded: false,
      });
      expect(repository.only()).toMatchObject({ status: 'PENDING' });
      expect(audit.records).toEqual([]);
    });
  });

  describe('when another writer changes the payment during the provider call', () => {
    it('still attaches the checkout after a concurrent description edit, keeping the new description', async () => {
      gateway.willAnswer(async (payment) => {
        await repository.concurrentWrite(payment.id, { description: 'Editada durante o checkout' });
        return {
          preferenceId: `pref-${payment.id}`,
          checkoutUrl: `https://checkout.example/${payment.id}`,
          collectorId: TEST_COLLECTOR_ID,
        };
      });

      const payment = await useCase.execute(CARD);

      expect(payment.toSnapshot()).toMatchObject({
        description: 'Editada durante o checkout',
        checkoutUrl: `https://checkout.example/${payment.id}`,
        version: 2,
      });
    });

    it('still records the failure after a concurrent description edit', async () => {
      gateway.willAnswer(async (payment) => {
        await repository.concurrentWrite(payment.id, { description: 'Editada durante o checkout' });
        throw new CheckoutRejectedError('Mercado Pago responded with status 400');
      });

      await expect(useCase.execute(CARD)).rejects.toMatchObject({ stateRecorded: true });
      expect(repository.only()).toMatchObject({ status: 'FAIL', description: 'Editada durante o checkout' });
      expect(audit.records).toHaveLength(1);
    });

    it('never lets the error handler overwrite a payment that was settled meanwhile', async () => {
      gateway.willAnswer(async (payment) => {
        await repository.concurrentWrite(payment.id, {
          status: 'PAID',
          failureReason: null,
          providerPaymentId: '42',
        });
        throw new CheckoutOutcomeUnknownError('timed out', true);
      });

      await expect(useCase.execute(CARD)).rejects.toThrow(CardCheckoutUncertainError);
      expect(repository.only()).toMatchObject({ status: 'PAID', providerPaymentId: '42' });
      expect(audit.records).toEqual([]);
    });

    it('returns a payment that was settled meanwhile as it is, without attaching over it', async () => {
      gateway.willAnswer(async (payment) => {
        await repository.concurrentWrite(payment.id, {
          status: 'PAID',
          failureReason: null,
          providerPaymentId: '42',
        });
        return {
          preferenceId: `pref-${payment.id}`,
          checkoutUrl: `https://checkout.example/${payment.id}`,
          collectorId: TEST_COLLECTOR_ID,
        };
      });

      const payment = await useCase.execute(CARD);

      expect(payment.toSnapshot()).toMatchObject({
        status: 'PAID',
        providerPaymentId: '42',
        checkoutUrl: null,
      });
    });
  });
});
