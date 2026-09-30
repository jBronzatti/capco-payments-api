import { randomUUID } from 'node:crypto';
import { ConcurrentUpdateError } from '../../src/application/errors';
import { PaymentRepository } from '../../src/application/ports/payment-repository';
import { ProviderPayment } from '../../src/application/ports/provider-payment-reader';
import { SettleCardPaymentUseCase } from '../../src/application/use-cases/settle-card-payment.use-case';
import { UpdatePaymentUseCase } from '../../src/application/use-cases/update-payment.use-case';
import { InvalidTransitionError } from '../../src/domain/payment/errors';
import { Payment } from '../../src/domain/payment/payment';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from '../../src/infrastructure/persistence/prisma-payment.repository';
import { TEST_COLLECTOR_ID } from '../fakes/fake-checkout-gateway';
import { FakeProviderPaymentReader } from '../fakes/fake-provider-payment-reader';
import { RecordingAnomalyLog } from '../fakes/recording-anomaly-log';
import { RecordingAuditLog } from '../fakes/recording-audit-log';
import { GatedRepository } from '../support/gated-repository';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';

let lastProviderId = 90_000;
/** payments.provider_payment_id is unique across the table, so every payment gets its own provider ids. */
const nextProviderId = () => String((lastProviderId += 1));

interface PendingCard {
  id: string;
  approval: string;
  rejection: string;
}

/**
 * Mercado Pago may deliver several notifications for one payment close together (created, updated, retries),
 * and a declined attempt can be followed by an approved one. Whatever order they commit in, a card payment
 * that was approved ends PAID, and its transition to PAID is written and audited once. A client's description
 * update racing the settlement cannot revert it either.
 */
describe('Concurrent card settlements against PostgreSQL: PAID never regresses', () => {
  let database: MigratedDatabase;
  let prisma: PrismaClient;
  let repository: PrismaPaymentRepository;
  let reader: FakeProviderPaymentReader;
  let anomalies: RecordingAnomalyLog;
  let audit: RecordingAuditLog;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    prisma = createPrismaClient(database.url);
    repository = new PrismaPaymentRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.container.stop();
  });

  beforeEach(() => {
    reader = new FakeProviderPaymentReader();
    anomalies = new RecordingAnomalyLog();
    audit = new RecordingAuditLog();
  });

  const settlement = (payments: PaymentRepository = repository) =>
    new SettleCardPaymentUseCase(payments, reader, anomalies, audit, TEST_COLLECTOR_ID);
  const descriptionUpdate = (payments: PaymentRepository, id: string, description: string) =>
    new UpdatePaymentUseCase(payments, audit).execute({
      id,
      description,
      actor: { id: 'client', canSettle: false },
    });

  const stored = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

  async function pendingCard(): Promise<PendingCard> {
    const id = randomUUID();
    const approval = nextProviderId();
    const rejection = nextProviderId();
    const at = new Date();
    await repository.insert(
      Payment.restore({
        id,
        cpf: '12345678909',
        description: 'Pedido cartão',
        amountCents: 1000,
        paymentMethod: 'CREDIT_CARD',
        status: 'PENDING',
        failureReason: null,
        providerPreferenceId: `pref-${id}`,
        checkoutUrl: `https://checkout.example/${id}`,
        providerPaymentId: null,
        version: 0,
        createdAt: at,
        updatedAt: at,
      }),
    );
    const bound = (overrides: Partial<ProviderPayment>): ProviderPayment => ({
      id: approval,
      status: 'approved',
      outcome: 'APPROVED',
      externalReference: id,
      amountCents: 1000,
      currency: 'BRL',
      paymentType: 'credit_card',
      collectorId: TEST_COLLECTOR_ID,
      ...overrides,
    });
    reader.willReturn(bound({}));
    reader.willReturn(bound({ id: rejection, status: 'rejected', outcome: 'REJECTED' }));
    return { id, approval, rejection };
  }

  it('turns a duplicate delivery that read before the first one committed into a no-op', async () => {
    const { id, approval } = await pendingCard();
    const gated = new GatedRepository(repository);
    const late = settlement(gated).execute({ providerPaymentId: approval });
    await gated.writeReached;

    await settlement().execute({ providerPaymentId: approval });
    gated.release();

    await expect(late).resolves.toEqual({ kind: 'NO_OP', paymentId: id });
    expect(gated.reads).toBe(2);
    expect(await stored(id)).toMatchObject({ status: 'PAID', providerPaymentId: approval, version: 1 });
    expect(audit.records).toEqual([
      { paymentId: id, from: 'PENDING', to: 'PAID', actor: 'system:mercado-pago' },
    ]);
  });

  it('keeps PAID when a rejection that read before the approval committed arrives late', async () => {
    const { id, approval, rejection } = await pendingCard();
    const gated = new GatedRepository(repository);
    const staleRejection = settlement(gated).execute({ providerPaymentId: rejection });
    await gated.writeReached;

    await settlement().execute({ providerPaymentId: approval });
    gated.release();

    await expect(staleRejection).resolves.toEqual({ kind: 'NO_OP', paymentId: id });
    expect(await stored(id)).toMatchObject({ status: 'PAID', failureReason: null, version: 1 });
    expect(audit.records.map((record) => record.to)).toEqual(['PAID']);
  });

  it('still settles an approval that read before a rejection committed', async () => {
    const { id, approval, rejection } = await pendingCard();
    const gated = new GatedRepository(repository);
    const approved = settlement(gated).execute({ providerPaymentId: approval });
    await gated.writeReached;

    await settlement().execute({ providerPaymentId: rejection });
    gated.release();

    await expect(approved).resolves.toEqual({ kind: 'APPLIED', paymentId: id });
    expect(await stored(id)).toMatchObject({ status: 'PAID', providerPaymentId: approval, version: 2 });
    expect(audit.records.map(({ from, to }) => `${from}->${to}`)).toEqual(['PENDING->FAIL', 'FAIL->PAID']);
  });

  it('ends PAID and settles once when an approval, its duplicate and a rejection race freely', async () => {
    for (let round = 0; round < 20; round += 1) {
      const { id, approval, rejection } = await pendingCard();

      const outcomes = await Promise.allSettled([
        settlement().execute({ providerPaymentId: approval }),
        settlement().execute({ providerPaymentId: approval }),
        settlement().execute({ providerPaymentId: rejection }),
      ]);

      expect(await stored(id)).toMatchObject({ status: 'PAID', providerPaymentId: approval });
      const settledToPaid = audit.records.filter((record) => record.paymentId === id && record.to === 'PAID');
      expect(settledToPaid).toHaveLength(1);
      // Losing twice to other writers is the only legitimate failure; it answers 503 to ask for redelivery.
      const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(failures.every(({ reason }) => reason instanceof ConcurrentUpdateError)).toBe(true);
    }
    expect(anomalies.anomalies).toEqual([]);
  });

  it('refuses a description update that read before the notification settled the payment', async () => {
    const { id, approval } = await pendingCard();
    const gated = new GatedRepository(repository);
    const staleEdit = descriptionUpdate(gated, id, 'Tarde');
    await gated.writeReached;

    await settlement().execute({ providerPaymentId: approval });
    gated.release();

    await expect(staleEdit).rejects.toThrow(InvalidTransitionError);
    expect(await stored(id)).toMatchObject({ status: 'PAID', description: 'Pedido cartão', version: 1 });
  });

  it('settles after a description update that committed first, keeping the new description', async () => {
    const { id, approval } = await pendingCard();
    const gated = new GatedRepository(repository);
    const approved = settlement(gated).execute({ providerPaymentId: approval });
    await gated.writeReached;

    await descriptionUpdate(repository, id, 'Editada');
    gated.release();

    await expect(approved).resolves.toEqual({ kind: 'APPLIED', paymentId: id });
    expect(await stored(id)).toMatchObject({ status: 'PAID', description: 'Editada', version: 2 });
  });
});
