import { randomUUID } from 'node:crypto';
import { ProviderAnomaly } from '../../src/application/ports/provider-anomaly-log';
import { Payment } from '../../src/domain/payment/payment';
import { PrismaClient } from '../../src/generated/prisma/client';
import { createPrismaClient } from '../../src/infrastructure/persistence/prisma-client.factory';
import { PrismaPaymentRepository } from '../../src/infrastructure/persistence/prisma-payment.repository';
import { PrismaProviderAnomalyLog } from '../../src/infrastructure/persistence/prisma-provider-anomaly-log';
import { MigratedDatabase, startMigratedPostgres } from '../support/postgres';

describe('PrismaProviderAnomalyLog (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let prisma: PrismaClient;
  let log: PrismaProviderAnomalyLog;
  let paymentId: string;

  beforeAll(async () => {
    database = await startMigratedPostgres();
    prisma = createPrismaClient(database.url);
    log = new PrismaProviderAnomalyLog(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await database?.container.stop();
  });

  beforeEach(async () => {
    await prisma.providerAnomaly.deleteMany();
    await prisma.payment.deleteMany();
    paymentId = randomUUID();
    const at = new Date('2026-09-29T12:00:00.000Z');
    await new PrismaPaymentRepository(prisma).insert(
      Payment.restore({
        id: paymentId,
        cpf: '12345678909',
        description: 'Pedido cartão',
        amountCents: 15075,
        paymentMethod: 'CREDIT_CARD',
        status: 'PAID',
        failureReason: null,
        providerPreferenceId: 'pref-1',
        checkoutUrl: 'https://checkout.example/pref-1',
        providerPaymentId: '9001',
        version: 2,
        createdAt: at,
        updatedAt: at,
      }),
    );
  });

  const mismatch = (overrides: Partial<ProviderAnomaly> = {}): ProviderAnomaly => ({
    kind: 'MISMATCH',
    paymentId,
    providerPaymentId: '9002',
    providerStatus: 'approved',
    mismatches: ['amount', 'paymentType'],
    ...overrides,
  });

  const rows = () =>
    prisma.providerAnomaly.findMany({
      select: {
        kind: true,
        paymentId: true,
        providerPaymentId: true,
        providerStatus: true,
        mismatches: true,
      },
    });

  it('keeps the evidence linked to the payment it concerns', async () => {
    await log.record(mismatch());

    expect(await rows()).toEqual([
      {
        kind: 'MISMATCH',
        paymentId,
        providerPaymentId: '9002',
        providerStatus: 'approved',
        mismatches: ['amount', 'paymentType'],
      },
    ]);
  });

  it('records a redelivered observation once, so retries cannot flood the table', async () => {
    await log.record(mismatch());
    await log.record(mismatch());

    expect(await rows()).toHaveLength(1);
  });

  it('keeps each status the provider payment reaches, so a later approval is never lost', async () => {
    await log.record(mismatch({ providerStatus: 'in_process' }));
    await log.record(mismatch({ providerStatus: 'approved' }));

    expect((await rows()).map((row) => row.providerStatus).sort()).toEqual(['approved', 'in_process']);
  });

  it('keeps different kinds of evidence about the same provider payment apart', async () => {
    await log.record(mismatch());
    await log.record({
      kind: 'DUPLICATE_APPROVAL',
      paymentId,
      providerPaymentId: '9002',
      providerStatus: 'approved',
      mismatches: [],
    });

    expect((await rows()).map((row) => row.kind).sort()).toEqual(['DUPLICATE_APPROVAL', 'MISMATCH']);
  });

  it('records a provider payment that cannot be tied to any payment of ours', async () => {
    await log.record({
      kind: 'UNKNOWN_REFERENCE',
      paymentId: null,
      providerPaymentId: '9003',
      providerStatus: 'approved',
      mismatches: [],
    });

    expect(await rows()).toEqual([expect.objectContaining({ kind: 'UNKNOWN_REFERENCE', paymentId: null })]);
  });

  // Overrides, not anomalies: the payment id only exists once beforeEach has run.
  it.each<[string, Partial<ProviderAnomaly>]>([
    ['a mismatch without the facts that disagree', { mismatches: [] }],
    ['an unknown reference that names a payment', { kind: 'UNKNOWN_REFERENCE' }],
    ['a known payment recorded without its id', { paymentId: null }],
    ['a provider payment id that is not numeric', { providerPaymentId: 'abc' }],
    ['a mismatch naming a fact that is never compared', { mismatches: ['cpf'] as never }],
  ])('refuses %s at the database too', async (_label, overrides) => {
    await expect(log.record(mismatch(overrides))).rejects.toThrow(/check constraint/);
    expect(await rows()).toEqual([]);
  });
});
