import { ConcurrentUpdateError } from '../../../src/application/errors';
import {
  ProviderPayment,
  ProviderUnavailableError,
} from '../../../src/application/ports/provider-payment-reader';
import { SettleCardPaymentUseCase } from '../../../src/application/use-cases/settle-card-payment.use-case';
import { Payment, PaymentChanges, PaymentSnapshot } from '../../../src/domain/payment/payment';
import { TEST_COLLECTOR_ID } from '../../fakes/fake-checkout-gateway';
import { FakeProviderPaymentReader } from '../../fakes/fake-provider-payment-reader';
import { InMemoryPaymentRepository } from '../../fakes/in-memory-payment.repository';
import { RecordingAnomalyLog } from '../../fakes/recording-anomaly-log';
import { RecordingAuditLog } from '../../fakes/recording-audit-log';

const ID = '0b7c8f0e-6a0e-4a53-9a57-0d7d9e0c1a11';
const ACTOR = 'system:mercado-pago';

function cardPayment(overrides: Partial<PaymentSnapshot> = {}): Payment {
  const at = new Date('2026-09-29T12:00:00.000Z');
  return Payment.restore({
    id: ID,
    cpf: '12345678909',
    description: 'Pedido cartão',
    amountCents: 15075,
    paymentMethod: 'CREDIT_CARD',
    status: 'PENDING',
    failureReason: null,
    providerPreferenceId: 'pref-1',
    checkoutUrl: 'https://checkout.example/pref-1',
    providerPaymentId: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });
}

function providerPayment(overrides: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    id: '9001',
    status: 'approved',
    outcome: 'APPROVED',
    externalReference: ID,
    amountCents: 15075,
    currency: 'BRL',
    paymentType: 'credit_card',
    collectorId: TEST_COLLECTOR_ID,
    ...overrides,
  };
}

/** Lets another writer commit between the use case's read and its conditional write. */
class InterleavingRepository extends InMemoryPaymentRepository {
  private readonly concurrentWrites: PaymentChanges[] = [];

  commitBeforeNextWrites(...changes: PaymentChanges[]): void {
    this.concurrentWrites.push(...changes);
  }

  override async update(id: string, expectedVersion: number, changes: PaymentChanges) {
    const concurrent = this.concurrentWrites.shift();
    if (concurrent) {
      const current = this.snapshot(id);
      await super.update(id, current?.version ?? -1, concurrent);
    }
    return super.update(id, expectedVersion, changes);
  }
}

describe('SettleCardPaymentUseCase', () => {
  let repository: InterleavingRepository;
  let reader: FakeProviderPaymentReader;
  let anomalies: RecordingAnomalyLog;
  let audit: RecordingAuditLog;
  let useCase: SettleCardPaymentUseCase;

  beforeEach(() => {
    repository = new InterleavingRepository();
    reader = new FakeProviderPaymentReader();
    anomalies = new RecordingAnomalyLog();
    audit = new RecordingAuditLog();
    useCase = new SettleCardPaymentUseCase(repository, reader, anomalies, audit, TEST_COLLECTOR_ID);
  });

  const settle = async (payment: ProviderPayment, stored: Payment = cardPayment()) => {
    await repository.insert(stored);
    reader.willReturn(payment);
    return useCase.execute({ providerPaymentId: payment.id });
  };

  describe('bound provider outcomes', () => {
    it('settles a pending payment on approval, recording the winning provider payment and who did it', async () => {
      const report = await settle(providerPayment());

      expect(report).toEqual({ kind: 'APPLIED', paymentId: ID });
      expect(repository.snapshot(ID)).toMatchObject({
        status: 'PAID',
        providerPaymentId: '9001',
        version: 2,
      });
      expect(audit.records).toEqual([{ paymentId: ID, from: 'PENDING', to: 'PAID', actor: ACTOR }]);
    });

    it('fails a pending payment on a confirmed rejection', async () => {
      await settle(providerPayment({ status: 'rejected', outcome: 'REJECTED' }));

      expect(repository.snapshot(ID)).toMatchObject({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' });
      expect(audit.records).toEqual([{ paymentId: ID, from: 'PENDING', to: 'FAIL', actor: ACTOR }]);
    });

    it('lets a bound approval supersede an earlier failure', async () => {
      await settle(providerPayment(), cardPayment({ status: 'FAIL', failureReason: 'PAYMENT_REJECTED' }));

      expect(repository.snapshot(ID)).toMatchObject({ status: 'PAID', failureReason: null });
      expect(audit.records).toEqual([{ paymentId: ID, from: 'FAIL', to: 'PAID', actor: ACTOR }]);
    });
  });

  describe('events that change nothing', () => {
    it.each([
      [
        'a repeated approval of the winning payment',
        providerPayment(),
        { status: 'PAID' as const, providerPaymentId: '9001' },
      ],
      [
        'a stale rejection after settlement',
        providerPayment({ id: '9002', status: 'rejected', outcome: 'REJECTED' }),
        { status: 'PAID' as const, providerPaymentId: '9001' },
      ],
      ['a payment still in progress', providerPayment({ status: 'in_process', outcome: 'IN_PROGRESS' }), {}],
      [
        'a status this service does not recognise',
        providerPayment({ status: 'something_new', outcome: 'UNRECOGNIZED' }),
        {},
      ],
    ])('treats %s as a no-op', async (_label, payment, state) => {
      const report = await settle(payment, cardPayment(state));

      expect(report).toEqual({ kind: 'NO_OP', paymentId: ID });
      expect(audit.records).toEqual([]);
      expect(anomalies.anomalies).toEqual([]);
    });
  });

  describe('anomalies that are preserved as evidence, without automatic refunds', () => {
    it('surfaces a different approved payment on an already paid charge as a possible duplicate charge', async () => {
      const report = await settle(
        providerPayment({ id: '9002' }),
        cardPayment({ status: 'PAID', providerPaymentId: '9001' }),
      );

      expect(report).toEqual({ kind: 'DUPLICATE_APPROVAL', paymentId: ID });
      expect(anomalies.anomalies).toEqual([
        expect.objectContaining({ kind: 'DUPLICATE_APPROVAL', paymentId: ID, providerPaymentId: '9002' }),
      ]);
      expect(repository.snapshot(ID)).toMatchObject({ status: 'PAID', providerPaymentId: '9001' });
    });

    it('records a reversal of the winning payment without transitioning', async () => {
      const report = await settle(
        providerPayment({ status: 'refunded', outcome: 'REVERSED' }),
        cardPayment({ status: 'PAID', providerPaymentId: '9001' }),
      );

      expect(report).toEqual({ kind: 'REVERSAL', paymentId: ID });
      expect(anomalies.anomalies).toEqual([
        expect.objectContaining({ kind: 'REVERSAL', providerStatus: 'refunded' }),
      ]);
      expect(repository.snapshot(ID)?.status).toBe('PAID');
    });

    it.each([
      ['an unknown reference', { externalReference: '7d4f6a3e-2b1c-4d5e-8f90-a1b2c3d4e5f6' }],
      ['a reference that is not one of our ids', { externalReference: 'order-123' }],
      ['a missing reference', { externalReference: null }],
    ])('records %s and acknowledges it, since redelivery cannot make it ours', async (_label, overrides) => {
      const report = await settle(providerPayment(overrides));

      expect(report).toEqual({ kind: 'UNKNOWN_REFERENCE', paymentId: null });
      expect(anomalies.anomalies).toEqual([
        expect.objectContaining({ kind: 'UNKNOWN_REFERENCE', paymentId: null, providerPaymentId: '9001' }),
      ]);
      expect(repository.snapshot(ID)?.status).toBe('PENDING');
    });
  });

  describe('binding: the provider payment must really be this charge', () => {
    it.each([
      ['a different amount', { amountCents: 15074 }, 'amount'],
      ['an amount that is not exactly in cents', { amountCents: null }, 'amount'],
      ['another currency', { currency: 'USD' }, 'currency'],
      ['a payment that did not use a credit card', { paymentType: 'account_money' }, 'paymentType'],
      ['another Mercado Pago account', { collectorId: '999' }, 'collector'],
    ])(
      'does not settle %s: the evidence is kept and the payment is not marked as rejected',
      async (_label, overrides, field) => {
        const report = await settle(providerPayment(overrides));

        expect(report).toEqual({ kind: 'MISMATCH', paymentId: ID });
        expect(anomalies.anomalies).toEqual([
          expect.objectContaining({
            kind: 'MISMATCH',
            paymentId: ID,
            providerStatus: 'approved',
            mismatches: [field],
          }),
        ]);
        expect(repository.snapshot(ID)).toMatchObject({ status: 'PENDING', version: 1 });
        expect(audit.records).toEqual([]);
      },
    );

    it.each([
      ['an approval', providerPayment()],
      ['a rejection', providerPayment({ status: 'rejected', outcome: 'REJECTED' })],
    ])('never applies %s to a PIX payment', async (_label, payment) => {
      const report = await settle(
        payment,
        cardPayment({ paymentMethod: 'PIX', providerPreferenceId: null, checkoutUrl: null }),
      );

      expect(report).toEqual({ kind: 'MISMATCH', paymentId: ID });
      expect(anomalies.anomalies[0]?.mismatches).toEqual(['paymentMethod']);
      expect(repository.snapshot(ID)).toMatchObject({ status: 'PENDING', version: 1 });
    });
  });

  describe('failures that Mercado Pago should retry', () => {
    it('lets a provider outage propagate without writing anything', async () => {
      await repository.insert(cardPayment());
      reader.willFail('9001', new ProviderUnavailableError('Mercado Pago responded with status 503'));

      await expect(useCase.execute({ providerPaymentId: '9001' })).rejects.toThrow(ProviderUnavailableError);
      expect(repository.snapshot(ID)?.version).toBe(1);
    });

    // The webhook answers 200 only when execute resolves, so a storage error must never be swallowed here.
    it.each([
      ['reading the payment', 'findById' as const],
      ['writing the settlement', 'update' as const],
    ])('lets a database failure while %s propagate, with nothing audited', async (_label, method) => {
      await repository.insert(cardPayment());
      reader.willReturn(providerPayment());
      jest.spyOn(repository, method).mockRejectedValueOnce(new Error('connection terminated'));

      await expect(useCase.execute({ providerPaymentId: '9001' })).rejects.toThrow('connection terminated');
      expect(repository.snapshot(ID)).toMatchObject({ status: 'PENDING', version: 1 });
      expect(audit.records).toEqual([]);
    });

    it('lets a failed anomaly write propagate, so the notification is refused (503) and can be redelivered', async () => {
      await repository.insert(cardPayment());
      reader.willReturn(providerPayment({ paymentType: 'account_money' }));
      jest.spyOn(anomalies, 'record').mockRejectedValueOnce(new Error('connection terminated'));

      await expect(useCase.execute({ providerPaymentId: '9001' })).rejects.toThrow('connection terminated');
    });

    it('re-reads and re-applies after a concurrent write', async () => {
      await repository.insert(cardPayment());
      reader.willReturn(providerPayment());
      repository.commitBeforeNextWrites({ description: 'Editada' });

      const report = await useCase.execute({ providerPaymentId: '9001' });

      expect(report.kind).toBe('APPLIED');
      expect(repository.snapshot(ID)).toMatchObject({ status: 'PAID', description: 'Editada', version: 3 });
      expect(audit.records).toHaveLength(1);
    });

    it('gives up with a conflict that asks for redelivery after a second concurrent write', async () => {
      await repository.insert(cardPayment());
      reader.willReturn(providerPayment());
      repository.commitBeforeNextWrites({ description: 'Primeira' }, { description: 'Segunda' });

      await expect(useCase.execute({ providerPaymentId: '9001' })).rejects.toThrow(ConcurrentUpdateError);
      expect(audit.records).toEqual([]);
    });
  });
});
